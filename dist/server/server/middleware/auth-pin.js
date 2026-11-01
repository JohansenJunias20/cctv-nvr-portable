import crypto from 'node:crypto';
const COOKIE_NAME = 'nvr_pin_session';
function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader)
        return out;
    for (const part of cookieHeader.split(';')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1)
            continue;
        const key = part.slice(0, eqIdx).trim();
        const val = part.slice(eqIdx + 1).trim();
        if (key)
            out[key] = decodeURIComponent(val);
    }
    return out;
}
function computePinToken(pin, secret) {
    return crypto.createHmac('sha256', secret).update(`pin:${pin}`).digest('hex');
}
function safeEqualStrings(a, b) {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length)
        return false;
    return crypto.timingSafeEqual(bufA, bufB);
}
export function isRequestPinAuthenticated(req, repos) {
    const s = repos.settings.get();
    if (!s.lanPin)
        return true;
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (!token)
        return false;
    const expected = computePinToken(s.lanPin, s.sessionSecret);
    return safeEqualStrings(token, expected);
}
const PUBLIC_API_PATHS = new Set([
    '/api/health',
    '/api/auth/status',
    '/api/auth/pin/verify',
    '/api/auth/pin/logout',
    '/api/gdrive/callback',
]);
export function registerPinAuth(app, repos) {
    app.addHook('onRequest', async (req, reply) => {
        const pathname = req.url.split('?')[0];
        if (!pathname.startsWith('/api/'))
            return;
        if (PUBLIC_API_PATHS.has(pathname))
            return;
        if (!isRequestPinAuthenticated(req, repos)) {
            return reply.code(401).send({
                error: 'PIN diperlukan untuk mengakses NVR.',
                pinRequired: true,
            });
        }
    });
    app.get('/api/auth/status', async (req) => {
        const s = repos.settings.get();
        const pinRequired = Boolean(s.lanPin);
        return {
            pinRequired,
            authenticated: isRequestPinAuthenticated(req, repos),
        };
    });
    app.post('/api/auth/pin/verify', async (req, reply) => {
        const s = repos.settings.get();
        if (!s.lanPin) {
            return { authenticated: true };
        }
        const candidatePin = String(req.body?.pin ?? '');
        if (!candidatePin || !safeEqualStrings(candidatePin, s.lanPin)) {
            return reply.code(401).send({ error: 'PIN salah.' });
        }
        const token = computePinToken(s.lanPin, s.sessionSecret);
        reply.header('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
        return { authenticated: true };
    });
    app.post('/api/auth/pin/logout', async (_req, reply) => {
        reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return { ok: true };
    });
}
