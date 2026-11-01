import WebSocket from 'ws';
import { getStreamKey } from '../media/go2rtc-manager.js';
export function registerStreamRoutes(app, deps) {
    // Bidirectional MSE / WebSocket relay to local go2rtc
    app.get('/api/streams/ws', { websocket: true }, (clientSocket, req) => {
        const cameraId = req.query.cameraId;
        const quality = req.query.quality === 'sub' ? 'sub' : 'main';
        if (!cameraId || !deps.repos.cameras.getById(cameraId)) {
            clientSocket.close(1008, 'Camera not found');
            return;
        }
        const streamKey = getStreamKey(cameraId, quality);
        const upstreamUrl = `${deps.go2rtc.wsBaseUrl}/api/ws?src=${encodeURIComponent(streamKey)}`;
        const upstream = new WebSocket(upstreamUrl);
        const pendingMessages = [];
        clientSocket.on('message', (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) {
                upstream.send(data, { binary: isBinary });
            }
            else if (upstream.readyState === WebSocket.CONNECTING) {
                pendingMessages.push({ data, isBinary });
            }
        });
        upstream.on('open', () => {
            for (const msg of pendingMessages) {
                upstream.send(msg.data, { binary: msg.isBinary });
            }
            pendingMessages.length = 0;
        });
        upstream.on('message', (data, isBinary) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(data, { binary: isBinary });
            }
        });
        const closeBoth = () => {
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
                upstream.close();
            }
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.close();
            }
        };
        clientSocket.on('close', closeBoth);
        clientSocket.on('error', closeBoth);
        upstream.on('close', closeBoth);
        upstream.on('error', closeBoth);
    });
    // WebRTC SDP offer/answer proxy (fallback for iOS Safari / WebRTC mode)
    app.post('/api/streams/webrtc', async (req, reply) => {
        const cameraId = req.query.cameraId;
        const quality = req.query.quality === 'sub' ? 'sub' : 'main';
        if (!cameraId || !deps.repos.cameras.getById(cameraId)) {
            return reply.code(404).send({ error: 'Kamera tidak ditemukan.' });
        }
        const sdpOffer = typeof req.body === 'string' ? req.body : req.body?.sdp;
        if (!sdpOffer) {
            return reply.code(400).send({ error: 'SDP offer kosong.' });
        }
        const streamKey = getStreamKey(cameraId, quality);
        const res = await fetch(`${deps.go2rtc.apiBaseUrl}/api/webrtc?src=${encodeURIComponent(streamKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: sdpOffer,
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            return reply.code(502).send({ error: 'Gagal membuka sesi WebRTC dari kamera.' });
        }
        const answerSdp = await res.text();
        return { type: 'answer', sdp: answerSdp };
    });
    // Snapshot JPEG frame proxy
    app.get('/api/streams/snapshot/:cameraId', async (req, reply) => {
        const cam = deps.repos.cameras.getById(req.params.cameraId);
        if (!cam)
            return reply.code(404).send({ error: 'Kamera tidak ditemukan.' });
        const streamKey = getStreamKey(cam.id, 'sub');
        try {
            const res = await fetch(`${deps.go2rtc.apiBaseUrl}/api/frame.jpeg?src=${encodeURIComponent(streamKey)}`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok)
                return reply.code(502).send({ error: 'Gagal mengambil snapshot.' });
            const buf = Buffer.from(await res.arrayBuffer());
            return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(buf);
        }
        catch {
            return reply.code(502).send({ error: 'Stream belum siap.' });
        }
    });
}
