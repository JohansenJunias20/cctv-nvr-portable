export function registerRecordingRoutes(app, deps) {
    app.get('/api/recordings', async (req) => {
        deps.recorder.harvestAllActive();
        const limit = Math.min(500, Math.max(10, Number(req.query.limit || 100)));
        return deps.repos.recordings.listRecent(limit);
    });
    app.post('/api/recordings/:cameraId/start', async (req, reply) => {
        const ok = await deps.recorder.startManual(req.params.cameraId);
        if (!ok) {
            return reply
                .code(404)
                .send({ error: 'Kamera tidak ditemukan atau sedang dinonaktifkan.' });
        }
        return deps.recorder.getStatus(req.params.cameraId);
    });
    app.post('/api/recordings/:cameraId/stop', async (req) => {
        await deps.recorder.stopManual(req.params.cameraId);
        deps.syncWorker.triggerSyncSoon();
        return deps.recorder.getStatus(req.params.cameraId);
    });
    app.post('/api/recordings/:id/retry', async (req, reply) => {
        const ok = deps.repos.recordings.resetRetry(req.params.id);
        if (!ok) {
            return reply.code(404).send({ error: 'File lokal sudah tidak tersedia untuk diunggah ulang.' });
        }
        deps.syncWorker.triggerSyncSoon(true);
        return { queued: true };
    });
    app.post('/api/recordings/sync-now', async () => {
        deps.recorder.harvestAllActive();
        await deps.syncWorker.processUploadQueue({ ignoreBackoff: true });
        const deletedCount = await deps.syncWorker.enforceRetention();
        return { ok: true, retentionDeletedCount: deletedCount };
    });
}
