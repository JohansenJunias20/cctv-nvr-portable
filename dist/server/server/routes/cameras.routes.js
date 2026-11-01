import { buildRtspUrl, maskRtspUrl, rewriteRtspUrlEndpoint, } from '../discovery/rtsp-url.js';
import { normalizeMac, resolveMacForIp } from '../discovery/ip-tracker.js';
function unmaskWithPassword(maybeMaskedUrl, password) {
    if (!maybeMaskedUrl.includes(':***@'))
        return maybeMaskedUrl;
    return maybeMaskedUrl.replace(':***@', `:${encodeURIComponent(password)}@`);
}
export function toPublicCamera(camera, recStatus) {
    const maskedMain = maskRtspUrl(camera.mainRtspUrl);
    const maskedSub = camera.subRtspUrl ? maskRtspUrl(camera.subRtspUrl) : null;
    const { password, ...rest } = camera;
    return {
        ...rest,
        mainRtspUrl: maskedMain,
        subRtspUrl: maskedSub,
        hasPassword: password.length > 0,
        maskedMainRtspUrl: maskedMain,
        maskedSubRtspUrl: maskedSub,
        isRecording: recStatus.isRecording,
        recordingMode: recStatus.mode,
    };
}
export function registerCameraRoutes(app, deps) {
    app.get('/api/cameras', async () => {
        return deps.repos.cameras
            .list()
            .map((c) => toPublicCamera(c, deps.recorder.getStatus(c.id)));
    });
    app.post('/api/cameras/discover', async () => {
        const candidates = await deps.discovery.scanLan();
        const existing = deps.repos.cameras.list();
        const existingIps = new Set(existing.map((c) => c.ipAddress));
        const existingMacs = new Set(existing.map((c) => c.macAddress).filter(Boolean));
        return candidates.map((c) => ({
            ...c,
            alreadyRegistered: existingIps.has(c.ipAddress) || (c.macAddress ? existingMacs.has(normalizeMac(c.macAddress)) : false),
        }));
    });
    app.post('/api/cameras/probe', async (req, reply) => {
        if (!req.body?.ipAddress) {
            return reply.code(400).send({ error: 'IP address kamera wajib diisi.' });
        }
        const res = await deps.discovery.probeCameraCredentials(req.body);
        const maskedMain = res.mainRtspUrl ? maskRtspUrl(res.mainRtspUrl) : null;
        const maskedSub = res.subRtspUrl ? maskRtspUrl(res.subRtspUrl) : null;
        return {
            ...res,
            mainRtspUrl: maskedMain,
            subRtspUrl: maskedSub,
            maskedMainRtspUrl: maskedMain,
            maskedSubRtspUrl: maskedSub,
        };
    });
    app.post('/api/cameras', async (req, reply) => {
        const body = req.body;
        if (!body?.name?.trim() || !body?.ipAddress?.trim()) {
            return reply.code(400).send({ error: 'Nama kamera dan IP address wajib diisi.' });
        }
        const username = body.username?.trim() || 'admin';
        const password = body.password ?? '';
        const port = Number(body.port || 554);
        let mainRtspUrl = body.mainRtspUrl?.trim() || '';
        if (!mainRtspUrl) {
            const defaultPath = body.brand === 'ezviz' ? '/h264/ch1/main/av_stream' : '/stream1';
            mainRtspUrl = buildRtspUrl({
                host: body.ipAddress.trim(),
                port,
                username,
                password,
                path: defaultPath,
            });
        }
        else {
            mainRtspUrl = unmaskWithPassword(mainRtspUrl, password);
        }
        const subRtspUrl = body.subRtspUrl
            ? unmaskWithPassword(body.subRtspUrl.trim(), password)
            : null;
        const macAddress = normalizeMac(body.macAddress) ?? (await resolveMacForIp(body.ipAddress.trim(), port));
        const created = deps.repos.cameras.create({
            name: body.name.trim(),
            ipAddress: body.ipAddress.trim(),
            macAddress,
            port,
            username,
            password,
            brand: body.brand ?? 'ezviz',
            mainRtspUrl,
            subRtspUrl,
            enabled: body.enabled ?? true,
        });
        await deps.go2rtc.syncCameraStreams(deps.repos.cameras.list());
        await deps.recorder.reconcileSchedules();
        return reply.code(201).send(toPublicCamera(created, deps.recorder.getStatus(created.id)));
    });
    app.put('/api/cameras/:id', async (req, reply) => {
        const current = deps.repos.cameras.getById(req.params.id);
        if (!current) {
            return reply.code(404).send({ error: 'Kamera tidak ditemukan.' });
        }
        const body = req.body ?? {};
        const effectiveIp = body.ipAddress?.trim() || current.ipAddress;
        const effectivePort = body.port !== undefined ? Number(body.port) : current.port;
        const effectiveUsername = body.username?.trim() || current.username;
        const effectivePassword = body.password !== undefined && body.password !== '' ? body.password : current.password;
        const endpointChanged = effectiveIp !== current.ipAddress ||
            effectivePort !== current.port ||
            effectiveUsername !== current.username ||
            effectivePassword !== current.password;
        const currentMaskedMain = maskRtspUrl(current.mainRtspUrl);
        const currentMaskedSub = current.subRtspUrl ? maskRtspUrl(current.subRtspUrl) : null;
        let mainRtspUrl;
        if (body.mainRtspUrl && body.mainRtspUrl.trim() !== currentMaskedMain) {
            mainRtspUrl = unmaskWithPassword(body.mainRtspUrl.trim(), effectivePassword);
        }
        else if (endpointChanged) {
            mainRtspUrl = rewriteRtspUrlEndpoint(current.mainRtspUrl, {
                host: effectiveIp,
                port: effectivePort,
                username: effectiveUsername,
                password: effectivePassword,
            });
        }
        else {
            mainRtspUrl = current.mainRtspUrl;
        }
        let subRtspUrl;
        if (body.subRtspUrl !== undefined && body.subRtspUrl !== currentMaskedSub) {
            subRtspUrl = body.subRtspUrl
                ? unmaskWithPassword(body.subRtspUrl.trim(), effectivePassword)
                : null;
        }
        else if (endpointChanged && current.subRtspUrl) {
            subRtspUrl = rewriteRtspUrlEndpoint(current.subRtspUrl, {
                host: effectiveIp,
                port: effectivePort,
                username: effectiveUsername,
                password: effectivePassword,
            });
        }
        else {
            subRtspUrl = current.subRtspUrl;
        }
        // IP edited by hand: it may be a different physical camera, so learn the MAC at the new address.
        const macAddress = effectiveIp !== current.ipAddress
            ? normalizeMac(body.macAddress) ?? (await resolveMacForIp(effectiveIp, effectivePort))
            : normalizeMac(body.macAddress) ?? current.macAddress;
        const updated = deps.repos.cameras.update(current.id, {
            ...body,
            macAddress,
            ipAddress: effectiveIp,
            port: effectivePort,
            username: effectiveUsername,
            password: effectivePassword,
            mainRtspUrl,
            subRtspUrl,
        });
        await deps.go2rtc.syncCameraStreams(deps.repos.cameras.list());
        await deps.recorder.reconcileSchedules();
        return toPublicCamera(updated, deps.recorder.getStatus(current.id));
    });
    app.delete('/api/cameras/:id', async (req, reply) => {
        await deps.recorder.stopManual(req.params.id);
        const ok = deps.repos.cameras.delete(req.params.id);
        if (!ok) {
            return reply.code(404).send({ error: 'Kamera tidak ditemukan.' });
        }
        await deps.go2rtc.syncCameraStreams(deps.repos.cameras.list());
        return { deleted: true };
    });
}
