import fs from 'node:fs';
export const ROOT_DRIVE_FOLDER_NAME = 'CCTV Recordings';
function escapeDriveQueryValue(val) {
    return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function isNotFoundError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const e = err;
    return e.code === 404 || e.code === '404' || e.status === 404 || e.response?.status === 404;
}
export function createGoogleDriveApiAdapter(drive) {
    return {
        async findFolder(name, parentId) {
            const parentClause = parentId ? ` and '${escapeDriveQueryValue(parentId)}' in parents` : '';
            const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapeDriveQueryValue(name)}' and trashed = false${parentClause}`;
            const res = await drive.files.list({
                q,
                fields: 'files(id, name)',
                pageSize: 1,
                spaces: 'drive',
            });
            return res.data.files?.[0]?.id ?? null;
        },
        async createFolder(name, parentId) {
            const res = await drive.files.create({
                requestBody: {
                    name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: parentId ? [parentId] : undefined,
                },
                fields: 'id',
            });
            if (!res.data.id)
                throw new Error(`Gagal membuat folder Google Drive: ${name}`);
            return res.data.id;
        },
        async uploadMp4({ fileName, parentFolderId, filePath }) {
            const res = await drive.files.create({
                requestBody: {
                    name: fileName,
                    parents: [parentFolderId],
                },
                media: {
                    mimeType: 'video/mp4',
                    body: fs.createReadStream(filePath),
                },
                fields: 'id, webViewLink',
            });
            if (!res.data.id)
                throw new Error('Google Drive tidak mengembalikan fileId');
            return {
                fileId: res.data.id,
                webViewLink: res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}/view`,
            };
        },
        async deletePermanent(fileId) {
            await drive.files.delete({ fileId });
        },
        async isFolderEmpty(folderId) {
            const res = await drive.files.list({
                q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
                fields: 'files(id)',
                pageSize: 1,
            });
            return (res.data.files?.length ?? 0) === 0;
        },
        async getQuota() {
            const res = await drive.about.get({ fields: 'storageQuota(limit,usage)' });
            const q = res.data.storageQuota;
            return {
                limitBytes: q?.limit ? Number(q.limit) : null,
                usageBytes: q?.usage ? Number(q.usage) : 0,
            };
        },
    };
}
function formatLocalDateFolder(isoTimestamp) {
    const dt = new Date(isoTimestamp);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
export function createDriveUploader(getApi) {
    const folderCache = new Map();
    const inflightFolders = new Map();
    async function ensureFolder(api, cacheKey, name, parentId) {
        const cached = folderCache.get(cacheKey);
        if (cached)
            return cached;
        const inflight = inflightFolders.get(cacheKey);
        if (inflight)
            return inflight;
        const task = (async () => {
            try {
                const existing = await api.findFolder(name, parentId);
                if (existing) {
                    folderCache.set(cacheKey, existing);
                    return existing;
                }
                const created = await api.createFolder(name, parentId);
                folderCache.set(cacheKey, created);
                return created;
            }
            finally {
                inflightFolders.delete(cacheKey);
            }
        })();
        inflightFolders.set(cacheKey, task);
        return task;
    }
    return {
        async isReady() {
            return (await getApi()) !== null;
        },
        async uploadRecording(item, cameraName) {
            const api = await getApi();
            if (!api) {
                throw new Error('Google Drive belum terhubung.');
            }
            if (!item.localPath || !fs.existsSync(item.localPath)) {
                throw new Error(`File lokal tidak ditemukan: ${item.localPath ?? item.fileName}`);
            }
            const camFolderLabel = (cameraName || item.cameraName || 'Camera').trim();
            const dateFolderLabel = formatLocalDateFolder(item.startedAt);
            const attemptUpload = async () => {
                const rootId = await ensureFolder(api, 'root', ROOT_DRIVE_FOLDER_NAME, null);
                const camFolderId = await ensureFolder(api, `cam:${camFolderLabel}`, camFolderLabel, rootId);
                const dateFolderId = await ensureFolder(api, `date:${camFolderLabel}:${dateFolderLabel}`, dateFolderLabel, camFolderId);
                const uploaded = await api.uploadMp4({
                    fileName: item.fileName,
                    parentFolderId: dateFolderId,
                    filePath: item.localPath,
                });
                return {
                    fileId: uploaded.fileId,
                    folderId: dateFolderId,
                    webViewLink: uploaded.webViewLink,
                };
            };
            try {
                return await attemptUpload();
            }
            catch (err) {
                if (isNotFoundError(err)) {
                    folderCache.clear();
                    return await attemptUpload();
                }
                throw err;
            }
        },
        async deleteDriveFilePermanent(fileId) {
            const api = await getApi();
            if (!api)
                throw new Error('Google Drive belum terhubung.');
            try {
                await api.deletePermanent(fileId);
                return true;
            }
            catch (err) {
                // Treat 404 (manually deleted by user in Drive web UI) as already absent
                if (isNotFoundError(err))
                    return false;
                throw err;
            }
        },
        async cleanupEmptyDateFolder(folderId) {
            const api = await getApi();
            if (!api)
                return;
            try {
                const empty = await api.isFolderEmpty(folderId);
                if (empty) {
                    await api.deletePermanent(folderId);
                    for (const [k, v] of folderCache.entries()) {
                        if (v === folderId)
                            folderCache.delete(k);
                    }
                }
            }
            catch {
                // non-fatal
            }
        },
        async getDriveQuota() {
            const api = await getApi();
            if (!api)
                return null;
            return api.getQuota();
        },
    };
}
