import { getLocalScanTargets, readSystemArpTable } from './network-utils.js';
import { discoverOnvifDevices } from './onvif-discovery.js';
import { probeRtspDescribe, probeRtspHost } from './port-scanner.js';
import { buildRtspUrl, generateCandidateRtspUrls } from './rtsp-url.js';
async function mapConcurrent(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function next() {
        while (cursor < items.length) {
            const idx = cursor++;
            results[idx] = await worker(items[idx]);
        }
    }
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
    await Promise.all(runners);
    return results;
}
export function createDiscoveryService(overrides = {}) {
    const deps = {
        getRegisteredIps: overrides.getRegisteredIps ?? (() => new Set()),
        getScanTargets: overrides.getScanTargets ?? getLocalScanTargets,
        discoverOnvif: overrides.discoverOnvif ?? discoverOnvifDevices,
        readArp: overrides.readArp ?? readSystemArpTable,
        probeHost: overrides.probeHost ?? probeRtspHost,
        probeDescribe: overrides.probeDescribe ?? probeRtspDescribe,
    };
    return {
        async scanLan() {
            const registeredIps = deps.getRegisteredIps();
            const targets = deps.getScanTargets();
            const [onvifHits, portProbeResults] = await Promise.all([
                deps.discoverOnvif(1400),
                mapConcurrent(targets, 45, async (ip) => ({
                    ip,
                    probe: await deps.probeHost(ip, [554, 8554, 8000], 350),
                })),
            ]);
            // Read ARP table AFTER port probes so fresh ARP entries are populated by OS!
            const arpMap = await deps.readArp();
            const onvifByIp = new Map(onvifHits.map((h) => [h.ipAddress, h]));
            const candidateIps = new Set();
            for (const hit of onvifHits)
                candidateIps.add(hit.ipAddress);
            for (const item of portProbeResults) {
                if (item.probe.openPorts.length > 0)
                    candidateIps.add(item.ip);
            }
            const probeByIp = new Map(portProbeResults.map((p) => [p.ip, p.probe]));
            const results = [];
            for (const ip of candidateIps) {
                const probe = probeByIp.get(ip) ?? { openPorts: [], isRtsp: false };
                const onvif = onvifByIp.get(ip);
                const arp = arpMap.get(ip);
                const bannerLower = (probe.serverHeader ?? '').toLowerCase();
                const isEzvizSignal = onvif?.brandHint === 'ezviz' ||
                    arp?.brandHint === 'ezviz' ||
                    bannerLower.includes('ezviz') ||
                    bannerLower.includes('hikvision') ||
                    probe.openPorts.includes(8000);
                const brandHint = isEzvizSignal ? 'ezviz' : 'generic';
                results.push({
                    ipAddress: ip,
                    macAddress: arp?.mac ?? null,
                    brandHint,
                    openPorts: probe.openPorts,
                    isRtspOpen: probe.isRtsp || probe.openPorts.includes(554) || probe.openPorts.includes(8554),
                    onvifEndpoint: onvif?.onvifEndpoint ?? null,
                    deviceName: onvif?.deviceName ??
                        (brandHint === 'ezviz' ? `Kamera Ezviz (${ip})` : `IP Camera (${ip})`),
                    serverBanner: probe.serverHeader ?? null,
                    alreadyRegistered: registeredIps.has(ip),
                });
            }
            return results.sort((a, b) => {
                if (a.brandHint !== b.brandHint)
                    return a.brandHint === 'ezviz' ? -1 : 1;
                return a.ipAddress.localeCompare(b.ipAddress, undefined, { numeric: true });
            });
        },
        async probeCameraCredentials(input) {
            const port = input.port ?? 554;
            const username = input.username ?? 'admin';
            const password = input.password ?? '';
            const candidates = input.customPath
                ? [
                    {
                        label: 'Custom RTSP Path',
                        mainUrl: buildRtspUrl({
                            host: input.ipAddress,
                            port,
                            username,
                            password,
                            path: input.customPath,
                        }),
                        subUrl: null,
                    },
                ]
                : generateCandidateRtspUrls({
                    host: input.ipAddress,
                    port,
                    username,
                    password,
                    brandHint: input.brandHint ?? 'ezviz',
                });
            let sawAuthFailure = false;
            let sawConnectionFailure = true;
            for (const candidate of candidates) {
                const res = await deps.probeDescribe(candidate.mainUrl, 1600);
                if (res.status > 0)
                    sawConnectionFailure = false;
                if (res.status === 200) {
                    let verifiedSubUrl = null;
                    if (candidate.subUrl) {
                        const subRes = await deps.probeDescribe(candidate.subUrl, 1200);
                        if (subRes.status === 200) {
                            verifiedSubUrl = candidate.subUrl;
                        }
                    }
                    return {
                        success: true,
                        authFailed: false,
                        matchedLabel: candidate.label,
                        mainRtspUrl: candidate.mainUrl,
                        subRtspUrl: verifiedSubUrl,
                        message: `Berhasil terhubung (${candidate.label})`,
                    };
                }
                if (res.status === 401 || res.status === 403) {
                    sawAuthFailure = true;
                }
            }
            if (sawAuthFailure) {
                return {
                    success: false,
                    authFailed: true,
                    matchedLabel: null,
                    mainRtspUrl: null,
                    subRtspUrl: null,
                    message: 'Kode Verifikasi Ezviz atau Password kamera ditolak (401 Unauthorized). Cek stiker di bodi bawah kamera.',
                };
            }
            if (sawConnectionFailure) {
                return {
                    success: false,
                    authFailed: false,
                    matchedLabel: null,
                    mainRtspUrl: null,
                    subRtspUrl: null,
                    message: `Tidak dapat menjangkau port RTSP ${input.ipAddress}:${port}. Pastikan kamera menyala & fitur LAN Live View aktif.`,
                };
            }
            return {
                success: false,
                authFailed: false,
                matchedLabel: null,
                mainRtspUrl: null,
                subRtspUrl: null,
                message: 'Port RTSP terbuka tetapi path stream standar tidak cocok. Silakan masukkan Custom RTSP URL kamera.',
            };
        },
    };
}
