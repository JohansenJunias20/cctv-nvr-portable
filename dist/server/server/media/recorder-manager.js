import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isScheduleActiveAt } from './schedule-evaluator.js';
// Keep the pause between a dropped recorder and its restart as short as possible so footage has no visible gap.
const RECONNECT_DELAY_MS = 1000;
export function buildFfmpegSegmentArgs(opts) {
    return [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-rtsp_transport',
        'tcp',
        // RTSP demuxer socket timeout (µs). `-rw_timeout` is rejected by the RTSP demuxer ("Option not found"),
        // which made ffmpeg exit instantly so nothing was ever recorded.
        '-timeout',
        '15000000',
        '-i',
        opts.rtspInputUrl,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-f',
        'segment',
        '-segment_time',
        String(opts.segmentSeconds),
        '-segment_format',
        'mp4',
        '-segment_format_options',
        'movflags=+frag_keyframe+empty_moov+default_base_moof',
        '-reset_timestamps',
        '1',
        '-strftime',
        '1',
        opts.outputPattern,
    ];
}
function sanitizeCameraSlug(name) {
    return name.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Camera';
}
function parseStartedAtFromFilename(fileName, fallbackMs) {
    const m = fileName.match(/_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/);
    if (m) {
        const [, y, mo, d, h, mi, s] = m;
        const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
        if (!Number.isNaN(dt.getTime()))
            return dt.toISOString();
    }
    return new Date(fallbackMs).toISOString();
}
function moveFileSafe(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        fs.renameSync(src, dest);
    }
    catch {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
    }
}
export function createRecorderManager(opts) {
    const spawnFn = opts.spawnProcess ??
        ((cmd, args) => spawn(cmd, args, {
            stdio: ['pipe', 'ignore', 'pipe'],
            windowsHide: true,
        }));
    const sessions = new Map();
    const reconnectTimers = new Map();
    const manualCameras = new Set();
    const suppressedScheduleCameras = new Set();
    let loopTimer = null;
    let minuteTimer = null;
    let shuttingDownAll = false;
    function clearReconnectTimer(cameraId) {
        const t = reconnectTimers.get(cameraId);
        if (t) {
            clearTimeout(t);
            reconnectTimers.delete(cameraId);
        }
    }
    function harvestCameraSegments(cameraId, cameraName, triggerType, flushAll) {
        const camActiveDir = path.join(opts.paths.activeRecordingsDir, cameraId);
        if (!fs.existsSync(camActiveDir))
            return 0;
        const mp4Files = fs
            .readdirSync(camActiveDir)
            .filter((f) => f.toLowerCase().endsWith('.mp4'))
            .sort();
        // Keep newest file untouched while FFmpeg is still writing to it
        const completedFiles = flushAll ? mp4Files : mp4Files.slice(0, -1);
        let movedCount = 0;
        for (const fileName of completedFiles) {
            const srcPath = path.join(camActiveDir, fileName);
            let stat;
            try {
                stat = fs.statSync(srcPath);
            }
            catch {
                continue;
            }
            if (stat.size === 0) {
                if (flushAll) {
                    try {
                        fs.unlinkSync(srcPath);
                    }
                    catch {
                        // ignore
                    }
                }
                continue;
            }
            // Isolate pending files per cameraId to prevent cross-camera filename collisions
            const destDir = path.join(opts.paths.pendingRecordingsDir, cameraId);
            let destPath = path.join(destDir, fileName);
            if (fs.existsSync(destPath)) {
                const ext = path.extname(fileName);
                const base = path.basename(fileName, ext);
                destPath = path.join(destDir, `${base}_${Date.now()}${ext}`);
            }
            try {
                moveFileSafe(srcPath, destPath);
            }
            catch {
                continue;
            }
            if (!opts.repos.recordings.getByLocalPath(destPath)) {
                opts.repos.recordings.create({
                    cameraId,
                    cameraName,
                    fileName: path.basename(destPath),
                    localPath: destPath,
                    sizeBytes: stat.size,
                    startedAt: parseStartedAtFromFilename(fileName, stat.birthtimeMs || stat.mtimeMs),
                    endedAt: new Date(stat.mtimeMs).toISOString(),
                    triggerType,
                    status: 'pending',
                });
                movedCount++;
            }
        }
        if (movedCount > 0) {
            opts.onSegmentReady?.();
        }
        return movedCount;
    }
    function spawnCameraRecorder(camera, mode) {
        if (sessions.has(camera.id) || shuttingDownAll)
            return;
        clearReconnectTimer(camera.id);
        const camActiveDir = path.join(opts.paths.activeRecordingsDir, camera.id);
        fs.mkdirSync(camActiveDir, { recursive: true });
        const segmentSeconds = (opts.repos.settings.get().segmentMinutes || 10) * 60;
        const slug = sanitizeCameraSlug(camera.name);
        const outputPattern = path.join(camActiveDir, `${slug}_%Y-%m-%d_%H-%M-%S.mp4`);
        const rtspInputUrl = opts.getRelayRtspUrl(camera.id);
        const args = buildFfmpegSegmentArgs({
            rtspInputUrl,
            segmentSeconds,
            outputPattern,
        });
        const proc = spawnFn(opts.ffmpegPath, args);
        // Drain stderr continuously so Windows OS 64KB pipe buffer never deadlocks FFmpeg
        proc.stderr?.on('data', () => undefined);
        proc.on('error', () => {
            sessions.delete(camera.id);
        });
        const session = {
            camera,
            mode,
            proc,
            stoppingIntentionally: false,
        };
        sessions.set(camera.id, session);
        proc.once('close', () => {
            sessions.delete(camera.id);
            if (!shuttingDownAll) {
                harvestCameraSegments(camera.id, camera.name, session.mode, true);
            }
            // Watchdog auto-reconnect re-evaluated at timer fire time, tracked in reconnectTimers map
            if (!session.stoppingIntentionally && !shuttingDownAll) {
                clearReconnectTimer(camera.id);
                const timer = setTimeout(() => {
                    reconnectTimers.delete(camera.id);
                    if (shuttingDownAll || sessions.has(camera.id))
                        return;
                    const latestCam = opts.repos.cameras.getById(camera.id);
                    if (!latestCam || !latestCam.enabled)
                        return;
                    const shouldManual = manualCameras.has(camera.id);
                    const rules = opts.repos.schedules.listByCamera(camera.id);
                    const shouldSchedule = !suppressedScheduleCameras.has(camera.id) && isScheduleActiveAt(rules, new Date());
                    if (shouldManual || shouldSchedule) {
                        spawnCameraRecorder(latestCam, shouldManual ? 'manual' : 'schedule');
                    }
                }, RECONNECT_DELAY_MS);
                reconnectTimers.set(camera.id, timer);
            }
        });
    }
    async function stopSession(cameraId) {
        clearReconnectTimer(cameraId);
        const session = sessions.get(cameraId);
        if (!session)
            return;
        session.stoppingIntentionally = true;
        await new Promise((resolve) => {
            const killTimer = setTimeout(() => {
                try {
                    session.proc.kill('SIGKILL');
                }
                catch {
                    // ignore
                }
                resolve();
            }, 3000);
            session.proc.once('close', () => {
                clearTimeout(killTimer);
                resolve();
            });
            try {
                if (session.proc.stdin && !session.proc.stdin.destroyed) {
                    session.proc.stdin.write('q\n');
                }
                else {
                    session.proc.kill('SIGTERM');
                }
            }
            catch {
                session.proc.kill('SIGTERM');
            }
        });
    }
    return {
        getStatus(cameraId) {
            const s = sessions.get(cameraId);
            if (!s)
                return { isRecording: false, mode: 'idle' };
            return { isRecording: true, mode: s.mode };
        },
        async startManual(cameraId) {
            const camera = opts.repos.cameras.getById(cameraId);
            if (!camera || !camera.enabled)
                return false;
            shuttingDownAll = false;
            clearReconnectTimer(cameraId);
            suppressedScheduleCameras.delete(cameraId);
            manualCameras.add(cameraId);
            const existing = sessions.get(cameraId);
            if (existing) {
                existing.mode = 'manual';
                return true;
            }
            spawnCameraRecorder(camera, 'manual');
            return true;
        },
        async stopManual(cameraId) {
            manualCameras.delete(cameraId);
            clearReconnectTimer(cameraId);
            const rules = opts.repos.schedules.listByCamera(cameraId);
            if (isScheduleActiveAt(rules, new Date())) {
                suppressedScheduleCameras.add(cameraId);
            }
            await stopSession(cameraId);
        },
        harvestAllActive() {
            for (const [cameraId, session] of sessions.entries()) {
                harvestCameraSegments(cameraId, session.camera.name, session.mode, false);
            }
        },
        async reconcileSchedules(now = new Date()) {
            this.harvestAllActive();
            const cameras = opts.repos.cameras.list();
            for (const cam of cameras) {
                if (!cam.enabled) {
                    manualCameras.delete(cam.id);
                    await stopSession(cam.id);
                    continue;
                }
                if (manualCameras.has(cam.id)) {
                    if (!sessions.has(cam.id) && !reconnectTimers.has(cam.id)) {
                        spawnCameraRecorder(cam, 'manual');
                    }
                    continue;
                }
                const rules = opts.repos.schedules.listByCamera(cam.id);
                const scheduleActive = isScheduleActiveAt(rules, now);
                if (!scheduleActive) {
                    suppressedScheduleCameras.delete(cam.id);
                    if (sessions.has(cam.id) || reconnectTimers.has(cam.id)) {
                        await stopSession(cam.id);
                    }
                }
                else if (!suppressedScheduleCameras.has(cam.id) &&
                    !sessions.has(cam.id) &&
                    !reconnectTimers.has(cam.id)) {
                    spawnCameraRecorder(cam, 'schedule');
                }
            }
        },
        recoverOrphanedActiveFiles() {
            if (!fs.existsSync(opts.paths.activeRecordingsDir))
                return;
            for (const cameraId of fs.readdirSync(opts.paths.activeRecordingsDir)) {
                const cam = opts.repos.cameras.getById(cameraId);
                const camName = cam?.name ?? 'Kamera';
                harvestCameraSegments(cameraId, camName, 'schedule', true);
            }
        },
        startBackgroundLoop(intervalMs = 15_000) {
            shuttingDownAll = false;
            this.recoverOrphanedActiveFiles();
            void this.reconcileSchedules().catch(() => undefined);
            if (loopTimer)
                clearInterval(loopTimer);
            loopTimer = setInterval(() => {
                void this.reconcileSchedules().catch(() => undefined);
            }, intervalMs);
            // Schedules are minute-granular: also reconcile right on each minute boundary so
            // recording starts/stops exactly at the configured time instead of up to intervalMs late.
            if (minuteTimer)
                clearTimeout(minuteTimer);
            const tickOnMinute = () => {
                minuteTimer = setTimeout(() => {
                    void this.reconcileSchedules().catch(() => undefined);
                    tickOnMinute();
                }, 60_000 - (Date.now() % 60_000) + 100);
            };
            tickOnMinute();
        },
        async stopAll() {
            shuttingDownAll = true;
            if (loopTimer) {
                clearInterval(loopTimer);
                loopTimer = null;
            }
            if (minuteTimer) {
                clearTimeout(minuteTimer);
                minuteTimer = null;
            }
            for (const t of reconnectTimers.values()) {
                clearTimeout(t);
            }
            reconnectTimers.clear();
            manualCameras.clear();
            await Promise.all(Array.from(sessions.keys()).map((id) => stopSession(id)));
        },
    };
}
