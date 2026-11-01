import fs from 'node:fs';
const BYTES_PER_GB = 1024 ** 3;
const MAX_BACKOFF_MS = 15 * 60_000; // Cap exponential backoff at 15 minutes; never permanently abandon
function computeBackoffMs(retryCount) {
    if (retryCount <= 0)
        return 0;
    return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (retryCount - 1));
}
export function createSyncAndRetentionWorker(opts) {
    const maxConcurrent = opts.maxConcurrentUploads ?? 2;
    const nextRetryAtById = new Map();
    let uploading = false;
    let rerunRequested = false;
    let retentionRunning = false;
    let periodicTimer = null;
    function unlinkQuietly(filePath) {
        if (!filePath)
            return;
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
        catch {
            // ignore
        }
    }
    return {
        enforceLocalOfflineCap() {
            const settings = opts.repos.settings.get();
            if (settings.maxLocalBufferGb <= 0)
                return 0;
            const capBytes = settings.maxLocalBufferGb * BYTES_PER_GB;
            let currentBytes = opts.repos.recordings.getTotalLocalPendingBytes();
            if (currentBytes <= capBytes)
                return 0;
            const candidates = opts.repos.recordings.listLocalBufferOldestFirst();
            let pruned = 0;
            for (const rec of candidates) {
                if (currentBytes <= capBytes)
                    break;
                unlinkQuietly(rec.localPath);
                opts.repos.recordings.deleteById(rec.id);
                nextRetryAtById.delete(rec.id);
                currentBytes -= rec.sizeBytes;
                pruned++;
            }
            return pruned;
        },
        async processUploadQueue(runOpts) {
            this.enforceLocalOfflineCap();
            if (runOpts?.ignoreBackoff) {
                nextRetryAtById.clear();
            }
            if (!(await opts.uploader.isReady())) {
                return;
            }
            if (uploading) {
                rerunRequested = true;
                return;
            }
            uploading = true;
            try {
                do {
                    rerunRequested = false;
                    const nowMs = Date.now();
                    const allPending = opts.repos.recordings.listPendingForUpload();
                    const eligible = allPending.filter((item) => {
                        if (runOpts?.ignoreBackoff)
                            return true;
                        const readyAt = nextRetryAtById.get(item.id) ?? 0;
                        return nowMs >= readyAt;
                    });
                    if (eligible.length === 0)
                        break;
                    let idx = 0;
                    let uploadedAny = false;
                    let abortWaveDueToOutage = false;
                    const worker = async () => {
                        while (idx < eligible.length && !abortWaveDueToOutage) {
                            const item = eligible[idx++];
                            if (!item.localPath || !fs.existsSync(item.localPath)) {
                                opts.repos.recordings.deleteById(item.id);
                                nextRetryAtById.delete(item.id);
                                continue;
                            }
                            opts.repos.recordings.markUploading(item.id);
                            try {
                                const cam = opts.repos.cameras.getById(item.cameraId);
                                const res = await opts.uploader.uploadRecording(item, cam?.name ?? item.cameraName);
                                unlinkQuietly(item.localPath);
                                opts.repos.recordings.markUploaded(item.id, {
                                    driveFileId: res.fileId,
                                    driveFolderId: res.folderId,
                                    webViewLink: res.webViewLink,
                                });
                                nextRetryAtById.delete(item.id);
                                uploadedAny = true;
                            }
                            catch (err) {
                                const msg = err instanceof Error ? err.message : 'Gagal mengunggah ke Google Drive';
                                opts.repos.recordings.markFailed(item.id, msg);
                                const newRetryCount = item.retryCount + 1;
                                nextRetryAtById.set(item.id, Date.now() + computeBackoffMs(newRetryCount));
                                // Stop hammering remaining queued files if network/Drive is currently unreachable
                                abortWaveDueToOutage = true;
                            }
                        }
                    };
                    await Promise.all(Array.from({ length: Math.min(maxConcurrent, eligible.length) }, () => worker()));
                    if (uploadedAny) {
                        await this.enforceRetention();
                    }
                } while (rerunRequested);
            }
            finally {
                uploading = false;
            }
        },
        async enforceRetention(now = new Date()) {
            if (retentionRunning)
                return 0;
            if (!(await opts.uploader.isReady()))
                return 0;
            retentionRunning = true;
            try {
                const settings = opts.repos.settings.get();
                const maxAgeMs = settings.maxRetentionDays > 0 ? settings.maxRetentionDays * 86_400_000 : null;
                const maxAppBytes = settings.maxDriveUsageGb > 0 ? settings.maxDriveUsageGb * BYTES_PER_GB : null;
                const minFreeBytes = settings.minDriveFreeGb > 0 ? settings.minDriveFreeGb * BYTES_PER_GB : null;
                let quota = null;
                try {
                    quota = await opts.uploader.getDriveQuota();
                }
                catch {
                    quota = null;
                }
                const uploadedOldestFirst = opts.repos.recordings.listUploadedOldestFirst();
                let totalAppBytes = opts.repos.recordings.getTotalUploadedBytes();
                let accountUsageBytes = quota?.usageBytes ?? 0;
                const accountLimitBytes = quota?.limitBytes ?? null;
                const touchedFolders = new Set();
                let deletedCount = 0;
                for (const rec of uploadedOldestFirst) {
                    const startedMs = new Date(rec.startedAt).getTime();
                    const isExpiredByDays = maxAgeMs !== null && !Number.isNaN(startedMs) && now.getTime() - startedMs > maxAgeMs;
                    const isOverAppQuota = maxAppBytes !== null && totalAppBytes > maxAppBytes;
                    const isLowAccountFree = minFreeBytes !== null &&
                        accountLimitBytes !== null &&
                        accountLimitBytes - accountUsageBytes < minFreeBytes;
                    if (!isExpiredByDays && !isOverAppQuota && !isLowAccountFree) {
                        break;
                    }
                    let actuallyDeletedFromDrive = false;
                    if (rec.driveFileId) {
                        try {
                            actuallyDeletedFromDrive = await opts.uploader.deleteDriveFilePermanent(rec.driveFileId);
                        }
                        catch {
                            // Network offline or transient API failure — stop cleanup safely without crashing or losing DB index
                            break;
                        }
                    }
                    if (rec.driveFolderId) {
                        touchedFolders.add(rec.driveFolderId);
                    }
                    opts.repos.recordings.deleteById(rec.id);
                    totalAppBytes = Math.max(0, totalAppBytes - rec.sizeBytes);
                    if (actuallyDeletedFromDrive) {
                        accountUsageBytes = Math.max(0, accountUsageBytes - rec.sizeBytes);
                    }
                    deletedCount++;
                }
                for (const folderId of touchedFolders) {
                    await opts.uploader.cleanupEmptyDateFolder(folderId);
                }
                return deletedCount;
            }
            finally {
                retentionRunning = false;
            }
        },
        triggerSyncSoon(ignoreBackoff = false) {
            void this.processUploadQueue({ ignoreBackoff }).catch(() => undefined);
        },
        startBackgroundLoop(intervalMs = 60_000) {
            void this.processUploadQueue().catch(() => undefined);
            if (periodicTimer)
                clearInterval(periodicTimer);
            periodicTimer = setInterval(() => {
                void this.processUploadQueue().catch(() => undefined);
                void this.enforceRetention().catch(() => undefined);
            }, intervalMs);
        },
        stopBackgroundLoop() {
            if (periodicTimer) {
                clearInterval(periodicTimer);
                periodicTimer = null;
            }
        },
    };
}
