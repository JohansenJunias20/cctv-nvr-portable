import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export function getStreamKey(cameraId, variant = 'main') {
    const safeId = cameraId.replace(/[^a-zA-Z0-9_-]/g, '');
    return `cam_${safeId}_${variant}`;
}
export function createGo2RtcManager(opts) {
    const apiPort = opts.apiPort ?? 1984;
    const rtspPort = opts.rtspPort ?? 8554;
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const wsBaseUrl = `ws://127.0.0.1:${apiPort}`;
    const configPath = path.join(opts.dataDir, 'go2rtc.yaml');
    let proc = null;
    let stopping = false;
    let currentCameras = [];
    let restartTimer = null;
    function writeConfigFile(cameras) {
        const lines = [
            'api:',
            `  listen: 127.0.0.1:${apiPort}`,
            '  origin: "*"',
            'rtsp:',
            `  listen: 127.0.0.1:${rtspPort}`,
            'webrtc:',
            '  candidates:',
            '    - stun:8555',
            'log:',
            '  level: warn',
            'streams:',
        ];
        const enabledCameras = cameras.filter((c) => c.enabled);
        if (enabledCameras.length === 0) {
            lines[lines.length - 1] = 'streams: {}';
        }
        else {
            for (const cam of enabledCameras) {
                const mainKey = getStreamKey(cam.id, 'main');
                const subKey = getStreamKey(cam.id, 'sub');
                lines.push(`  ${mainKey}: ${JSON.stringify(cam.mainRtspUrl)}`);
                lines.push(`  ${subKey}: ${JSON.stringify(cam.subRtspUrl || cam.mainRtspUrl)}`);
            }
        }
        fs.writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
    }
    async function waitUntilReady(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(`${apiBaseUrl}/api`, { signal: AbortSignal.timeout(600) });
                if (res.ok)
                    return true;
            }
            catch {
                // retry shortly
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        return false;
    }
    return {
        apiBaseUrl,
        wsBaseUrl,
        rtspPort,
        getCurrentCameras() {
            return [...currentCameras];
        },
        getLocalRtspUrl(cameraId, variant = 'main') {
            return `rtsp://127.0.0.1:${rtspPort}/${getStreamKey(cameraId, variant)}`;
        },
        async start(cameras) {
            stopping = false;
            if (cameras !== undefined) {
                currentCameras = [...cameras];
            }
            writeConfigFile(currentCameras);
            if (proc)
                return;
            proc = spawn(opts.go2rtcPath, ['-config', configPath], {
                cwd: opts.dataDir,
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });
            // Drain stderr pipe continuously so OS pipe buffer never fills and deadlocks go2rtc
            proc.stderr?.resume();
            proc.on('error', () => {
                proc = null;
            });
            proc.on('close', () => {
                proc = null;
                if (!stopping) {
                    restartTimer = setTimeout(() => {
                        restartTimer = null;
                        if (!stopping)
                            void this.start();
                    }, 2500);
                }
            });
            await waitUntilReady(5000);
        },
        async syncCameraStreams(cameras) {
            currentCameras = [...cameras];
            writeConfigFile(currentCameras);
            if (!proc)
                return;
            try {
                const existingRes = await fetch(`${apiBaseUrl}/api/streams`, {
                    signal: AbortSignal.timeout(1500),
                });
                const existingStreams = existingRes.ok
                    ? Object.keys((await existingRes.json()))
                    : [];
                const desired = new Map();
                for (const cam of currentCameras) {
                    if (!cam.enabled)
                        continue;
                    desired.set(getStreamKey(cam.id, 'main'), cam.mainRtspUrl);
                    desired.set(getStreamKey(cam.id, 'sub'), cam.subRtspUrl || cam.mainRtspUrl);
                }
                for (const oldKey of existingStreams) {
                    if (!desired.has(oldKey)) {
                        await fetch(`${apiBaseUrl}/api/streams?src=${encodeURIComponent(oldKey)}`, {
                            method: 'DELETE',
                            signal: AbortSignal.timeout(1500),
                        }).catch(() => undefined);
                    }
                }
                for (const [key, srcUrl] of desired.entries()) {
                    await fetch(`${apiBaseUrl}/api/streams?name=${encodeURIComponent(key)}&src=${encodeURIComponent(srcUrl)}`, {
                        method: 'PUT',
                        signal: AbortSignal.timeout(1500),
                    }).catch(() => undefined);
                }
            }
            catch {
                // go2rtc will reload from go2rtc.yaml on next start if temporarily busy
            }
        },
        async stop() {
            stopping = true;
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            if (!proc)
                return;
            const current = proc;
            proc = null;
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    current.kill('SIGKILL');
                    resolve();
                }, 2000);
                current.once('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
                current.kill('SIGTERM');
            });
        },
    };
}
