import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { getHostLanIps } from './discovery/network-utils.js';
import { registerPinAuth } from './middleware/auth-pin.js';
import { registerCameraRoutes } from './routes/cameras.routes.js';
import { registerRecordingRoutes } from './routes/recordings.routes.js';
import { registerScheduleRoutes } from './routes/schedules.routes.js';
import { registerSettingsRoutes } from './routes/settings.routes.js';
import { registerStreamRoutes } from './routes/streams.routes.js';
export async function buildApp(deps) {
    const app = Fastify({ logger: false });
    await app.register(fastifyCors, { origin: true, credentials: true });
    await app.register(fastifyWebsocket);
    app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
    app.get('/api/system/network-info', async () => {
        const lanIps = getHostLanIps();
        return {
            port: deps.serverPort,
            localUrl: `http://localhost:${deps.serverPort}`,
            lanUrls: lanIps.map((ip) => `http://${ip}:${deps.serverPort}`),
        };
    });
    registerPinAuth(app, deps.repos);
    registerCameraRoutes(app, deps);
    registerScheduleRoutes(app, deps);
    registerRecordingRoutes(app, deps);
    registerSettingsRoutes(app, deps);
    registerStreamRoutes(app, deps);
    // Serve built React SPA when dist/client exists
    if (fs.existsSync(deps.paths.clientDistDir)) {
        await app.register(fastifyStatic, {
            root: deps.paths.clientDistDir,
            prefix: '/',
            wildcard: false,
        });
        app.setNotFoundHandler((req, reply) => {
            if (req.url.startsWith('/api/')) {
                return reply.code(404).send({ error: 'API route not found' });
            }
            const indexHtml = path.join(deps.paths.clientDistDir, 'index.html');
            if (fs.existsSync(indexHtml)) {
                return reply.type('text/html').send(fs.readFileSync(indexHtml));
            }
            return reply.code(404).send('UI belum di-build. Jalankan npm run build.');
        });
    }
    return app;
}
