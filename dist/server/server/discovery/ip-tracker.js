import net from 'node:net';
import { getLocalScanTargets, readSystemArpTable } from './network-utils.js';
import { probeRtspDescribe } from './port-scanner.js';
// Cameras are identified by MAC address because their IP changes with DHCP.
// This tracker notices when a camera is no longer at its stored IP, finds the
// same MAC elsewhere on the LAN, and rewrites the camera's IP + RTSP URLs.
const MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
export function normalizeMac(raw) {
    if (!raw)
        return null;
    const mac = String(raw).trim().toLowerCase().replace(/-/g, ':');
    return MAC_REGEX.test(mac) ? mac : null;
}
// Any TCP answer (accepted or refused) proves the host is alive and puts its MAC in the OS ARP cache.
export function pingTcp(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs, () => finish('dead'));
        socket.once('connect', () => finish('open'));
        socket.once('error', (err) => finish(err.code === 'ECONNREFUSED' ? 'refused' : 'dead'));
        socket.connect(port, ip);
    });
}
export async function resolveMacForIp(ip, port = 554, deps = {}) {
    const ping = deps.pingTcp ?? pingTcp;
    const readArp = deps.readArp ?? readSystemArpTable;
    const state = await ping(ip, port, 1200);
    if (state === 'dead')
        return null;
    return normalizeMac((await readArp()).get(ip)?.mac);
}
async function mapConcurrent(items, concurrency, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            await worker(items[cursor++]);
        }
    });
    await Promise.all(runners);
}
function swapHost(url, oldHost, newHost) {
    const m = url.match(/^(rtsps?:\/\/(?:[^/]*@)?)([^:/]+)(.*)$/i);
    if (!m || m[2] !== oldHost)
        return url;
    return `${m[1]}${newHost}${m[3]}`;
}
export function createCameraIpTracker(opts) {
    const getScanTargets = opts.getScanTargets ?? getLocalScanTargets;
    const readArp = opts.readArp ?? readSystemArpTable;
    const ping = opts.pingTcp ?? pingTcp;
    const probeDescribe = opts.probeDescribe ?? probeRtspDescribe;
    const log = opts.log ?? ((msg) => console.log(msg));
    let running = false;
    let timer = null;
    async function isAtStoredAddress(cam) {
        const state = await ping(cam.ipAddress, cam.port, 800);
        if (state === 'dead')
            return false;
        const seen = normalizeMac((await readArp()).get(cam.ipAddress)?.mac);
        // Alive but MAC unknown: assume fine. A different MAC means another device took this IP.
        return !seen || seen === cam.macAddress;
    }
    async function findAliveMacs() {
        const alive = new Set();
        await mapConcurrent(getScanTargets(), 64, async (ip) => {
            if ((await ping(ip, 554, 500)) !== 'dead')
                alive.add(ip);
        });
        const macToIp = new Map();
        for (const [ip, info] of await readArp()) {
            const mac = normalizeMac(info.mac);
            if (mac && alive.has(ip))
                macToIp.set(mac, ip);
        }
        return macToIp;
    }
    // Cameras added before MAC tracking: learn the MAC, but only after RTSP proves this IP is really the camera.
    async function backfillMac(cam) {
        const res = await probeDescribe(cam.mainRtspUrl, 2500);
        if (res.status !== 200)
            return;
        const mac = normalizeMac((await readArp()).get(cam.ipAddress)?.mac);
        if (mac) {
            opts.repos.cameras.update(cam.id, { macAddress: mac });
            log(`[CCTV NVR] MAC kamera "${cam.name}" tersimpan (${mac}).`);
        }
    }
    function relocate(cam, newIp) {
        const mainRtspUrl = swapHost(cam.mainRtspUrl, cam.ipAddress, newIp);
        const subRtspUrl = cam.subRtspUrl ? swapHost(cam.subRtspUrl, cam.ipAddress, newIp) : null;
        opts.repos.cameras.update(cam.id, { ipAddress: newIp, mainRtspUrl, subRtspUrl });
        log(`[CCTV NVR] Kamera "${cam.name}" pindah IP ${cam.ipAddress} -> ${newIp} (MAC ${cam.macAddress}).`);
    }
    async function checkOnce() {
        if (running)
            return;
        running = true;
        try {
            const cameras = opts.repos.cameras.list().filter((c) => c.enabled);
            for (const cam of cameras.filter((c) => !c.macAddress)) {
                await backfillMac(cam).catch(() => undefined);
            }
            const tracked = cameras.filter((c) => normalizeMac(c.macAddress));
            const lost = [];
            for (const cam of tracked) {
                if (!(await isAtStoredAddress(cam)))
                    lost.push(cam);
            }
            if (lost.length === 0)
                return;
            const macToIp = await findAliveMacs();
            let changed = false;
            for (const cam of lost) {
                const newIp = macToIp.get(cam.macAddress);
                if (newIp && newIp !== cam.ipAddress) {
                    relocate(cam, newIp);
                    changed = true;
                }
            }
            if (changed) {
                await opts.go2rtc.syncCameraStreams(opts.repos.cameras.list());
            }
        }
        finally {
            running = false;
        }
    }
    return {
        checkOnce,
        startBackgroundLoop(intervalMs = 30_000) {
            if (timer)
                clearInterval(timer);
            timer = setInterval(() => {
                void checkOnce().catch(() => undefined);
            }, intervalMs);
        },
        stopBackgroundLoop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
}
