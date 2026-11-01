import { resolveAppPaths } from './config/paths.js';
import { createDatabase } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { createDiscoveryService } from './discovery/discovery-service.js';
import { findAvailablePort, getHostLanIps } from './discovery/network-utils.js';
import { createCameraIpTracker } from './discovery/ip-tracker.js';
import { createDriveUploader } from './gdrive/drive-uploader.js';
import { createGoogleOAuthManager } from './gdrive/oauth-client.js';
import { createSyncAndRetentionWorker } from './gdrive/retention-service.js';
import { ensureMediaBinaries } from './media/binary-manager.js';
import { createGo2RtcManager } from './media/go2rtc-manager.js';
import { createRecorderManager } from './media/recorder-manager.js';
import { buildApp } from './app.js';
async function main() {
    const preferredPort = Number(process.env.PORT || 3800);
    const port = await findAvailablePort(preferredPort, '0.0.0.0');
    if (port !== preferredPort) {
        console.log(`[CCTV NVR] Port ${preferredPort} sedang dipakai aplikasi lain, otomatis beralih ke port ${port}.`);
    }
    const paths = resolveAppPaths(process.cwd());
    console.log('[CCTV NVR] Memeriksa komponen media (FFmpeg & go2rtc)...');
    const { ffmpegPath, go2rtcPath } = await ensureMediaBinaries(paths.binDir);
    const db = createDatabase(paths.dbPath);
    const repos = createRepositories(db);
    const go2rtc = createGo2RtcManager({
        go2rtcPath,
        dataDir: paths.dataDir,
    });
    // Cameras are tracked by MAC: fix any changed IPs before streams/recorders start.
    const ipTracker = createCameraIpTracker({ repos, go2rtc });
    await ipTracker.checkOnce().catch(() => undefined);
    try {
        await go2rtc.start(repos.cameras.list());
        const oauth = createGoogleOAuthManager(repos);
        const uploader = createDriveUploader(() => oauth.getDriveApiAdapter());
        const syncWorker = createSyncAndRetentionWorker({
            paths,
            repos,
            uploader,
        });
        const recorder = createRecorderManager({
            paths,
            repos,
            ffmpegPath,
            getRelayRtspUrl: (cameraId) => go2rtc.getLocalRtspUrl(cameraId, 'main'),
            onSegmentReady: () => syncWorker.triggerSyncSoon(),
        });
        const discovery = createDiscoveryService({
            getRegisteredIps: () => new Set(repos.cameras.list().map((c) => c.ipAddress)),
        });
        const app = await buildApp({
            paths,
            repos,
            discovery,
            go2rtc,
            recorder,
            oauth,
            uploader,
            syncWorker,
            serverPort: port,
        });
        recorder.startBackgroundLoop(15_000);
        syncWorker.startBackgroundLoop(60_000);
        ipTracker.startBackgroundLoop(30_000);
        await app.listen({ host: '0.0.0.0', port });
        const lanIps = getHostLanIps();
        console.log('==========================================================');
        console.log(`  CCTV Ezviz & RTSP Local NVR Aktif!`);
        console.log(`  Buka di PC ini      : http://localhost:${port}`);
        for (const ip of lanIps) {
            console.log(`  Buka dari HP/Wi-Fi  : http://${ip}:${port}`);
        }
        console.log('==========================================================');
        let shuttingDown = false;
        const shutdown = async () => {
            if (shuttingDown)
                return;
            shuttingDown = true;
            console.log('\n[CCTV NVR] Menyimpan segmen rekaman & menutup layanan...');
            syncWorker.stopBackgroundLoop();
            ipTracker.stopBackgroundLoop();
            await recorder.stopAll();
            await go2rtc.stop();
            await app.close();
            db.close();
            process.exit(0);
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
    }
    catch (err) {
        await go2rtc.stop().catch(() => undefined);
        db.close();
        throw err;
    }
}
main().catch((err) => {
    console.error('[CCTV NVR] Gagal menjalankan server:', err);
    process.exit(1);
});
