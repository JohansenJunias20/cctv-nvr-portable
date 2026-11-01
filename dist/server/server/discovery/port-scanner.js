import net from 'node:net';
import crypto from 'node:crypto';
function checkTcpPort(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok) => {
            if (done)
                return;
            done = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}
function sendRtspOverFreshSocket(host, port, rawRequest, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let buffer = '';
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(buffer);
        };
        const timer = setTimeout(finish, timeoutMs);
        socket.setTimeout(timeoutMs);
        socket.once('timeout', finish);
        socket.once('error', finish);
        socket.once('close', finish);
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (buffer.includes('\r\n\r\n')) {
                finish();
            }
        });
        socket.once('connect', () => {
            socket.write(rawRequest);
        });
        socket.connect(port, host);
    });
}
// Digest nonces on Ezviz/Hikvision cameras are bound to the TCP connection, so the
// authenticated DESCRIBE must reuse the socket that received the 401 challenge.
function openRtspSession(host, port, timeoutMs) {
    const socket = new net.Socket();
    let buffer = '';
    let waiter = null;
    let closed = false;
    const settle = () => {
        if (!waiter)
            return;
        const w = waiter;
        waiter = null;
        clearTimeout(w.timer);
        w.resolve(buffer);
    };
    const connected = new Promise((resolve) => {
        socket.once('connect', () => resolve(true));
        socket.once('error', () => resolve(false));
        socket.setTimeout(timeoutMs, () => resolve(false));
    });
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\r\n\r\n'))
            settle();
    });
    socket.on('error', () => { closed = true; settle(); });
    socket.on('close', () => { closed = true; settle(); });
    socket.connect(port, host);
    return {
        async request(raw) {
            if (!(await connected) || closed)
                return '';
            buffer = '';
            return new Promise((resolve) => {
                waiter = { resolve, timer: setTimeout(settle, timeoutMs) };
                socket.write(raw);
            });
        },
        isClosed: () => closed,
        close: () => socket.destroy(),
    };
}
export async function probeRtspHost(host, ports = [554, 8554, 8000], timeoutMs = 450) {
    const checks = await Promise.all(ports.map(async (p) => ({ port: p, open: await checkTcpPort(host, p, timeoutMs) })));
    const openPorts = checks.filter((c) => c.open).map((c) => c.port);
    const rtspPort = openPorts.find((p) => p === 554 || p === 8554) ?? openPorts[0];
    if (!rtspPort) {
        return { openPorts: [], isRtsp: false };
    }
    const resp = await sendRtspOverFreshSocket(host, rtspPort, `OPTIONS rtsp://${host}:${rtspPort}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: CCTV-NVR/1.0\r\n\r\n`, timeoutMs);
    const isRtsp = resp.startsWith('RTSP/1.0');
    const serverMatch = resp.match(/^Server:\s*(.+)$/im);
    return {
        openPorts,
        isRtsp: isRtsp || openPorts.includes(554),
        serverHeader: serverMatch?.[1]?.trim(),
    };
}
function md5Hex(input) {
    return crypto.createHash('md5').update(input).digest('hex');
}
function buildDigestHeader(opts) {
    const realm = opts.wwwAuthHeader.match(/realm="([^"]+)"/i)?.[1];
    const nonce = opts.wwwAuthHeader.match(/nonce="([^"]+)"/i)?.[1];
    if (!realm || !nonce)
        return null;
    const opaque = opts.wwwAuthHeader.match(/opaque="([^"]+)"/i)?.[1];
    const qopRaw = opts.wwwAuthHeader.match(/qop="?([^",]+)"?/i)?.[1];
    const supportsAuthQop = qopRaw
        ? qopRaw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .includes('auth')
        : false;
    const ha1 = md5Hex(`${opts.username}:${realm}:${opts.password}`);
    const ha2 = md5Hex(`${opts.method}:${opts.uri}`);
    if (supportsAuthQop) {
        const nc = '00000001';
        const cnonce = crypto.randomBytes(8).toString('hex');
        const response = md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
        const opaquePart = opaque ? `, opaque="${opaque}"` : '';
        return `Digest username="${opts.username}", realm="${realm}", nonce="${nonce}", uri="${opts.uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"${opaquePart}`;
    }
    const response = md5Hex(`${ha1}:${nonce}:${ha2}`);
    const opaquePart = opaque ? `, opaque="${opaque}"` : '';
    return `Digest username="${opts.username}", realm="${realm}", nonce="${nonce}", uri="${opts.uri}", response="${response}"${opaquePart}`;
}
export async function probeRtspDescribe(rtspUrl, timeoutMs = 1500) {
    let parsed;
    try {
        parsed = new URL(rtspUrl);
    }
    catch {
        return { status: 0, rawHeaders: 'invalid url' };
    }
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 554;
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    const cleanUri = `rtsp://${host}:${port}${parsed.pathname}${parsed.search}`;
    const session = openRtspSession(host, port, timeoutMs);
    try {
        return await describeWithAuth(session, host, port, cleanUri, username, password, timeoutMs);
    }
    finally {
        session.close();
    }
}
async function describeWithAuth(session, host, port, cleanUri, username, password, timeoutMs) {
    const firstResp = await session.request(`DESCRIBE ${cleanUri} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\nUser-Agent: CCTV-NVR/1.0\r\n\r\n`);
    const firstStatus = Number(firstResp.match(/^RTSP\/1\.0\s+(\d{3})/)?.[1] ?? 0);
    if (firstStatus !== 401 || !username) {
        return { status: firstStatus, rawHeaders: firstResp };
    }
    const wwwAuthLines = firstResp
        .split('\r\n')
        .filter((l) => /^WWW-Authenticate:/i.test(l))
        .map((l) => l.replace(/^WWW-Authenticate:\s*/i, '').trim());
    let authHeader = null;
    const digestChallenge = wwwAuthLines.find((h) => /^Digest/i.test(h));
    if (digestChallenge) {
        authHeader = buildDigestHeader({
            username,
            password,
            method: 'DESCRIBE',
            uri: cleanUri,
            wwwAuthHeader: digestChallenge,
        });
    }
    if (!authHeader) {
        const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
        authHeader = `Basic ${token}`;
    }
    const authRequest = `DESCRIBE ${cleanUri} RTSP/1.0\r\nCSeq: 3\r\nAccept: application/sdp\r\nAuthorization: ${authHeader}\r\nUser-Agent: CCTV-NVR/1.0\r\n\r\n`;
    let secondResp = session.isClosed() ? '' : await session.request(authRequest);
    if (!secondResp) {
        // Camera closed the socket after the 401: fall back to a fresh connection (works for Basic).
        secondResp = await sendRtspOverFreshSocket(host, port, authRequest, timeoutMs);
    }
    const secondStatus = Number(secondResp.match(/^RTSP\/1\.0\s+(\d{3})/)?.[1] ?? 0);
    return { status: secondStatus, rawHeaders: secondResp };
}
