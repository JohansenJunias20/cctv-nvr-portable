const HH_MM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function registerScheduleRoutes(app, deps) {
    app.get('/api/schedules', async () => {
        return deps.repos.schedules.listAll();
    });
    app.post('/api/schedules', async (req, reply) => {
        const b = req.body;
        if (!b?.cameraId || !deps.repos.cameras.getById(b.cameraId)) {
            return reply.code(400).send({ error: 'Kamera tujuan jadwal tidak valid.' });
        }
        if (!HH_MM_REGEX.test(b.startTime ?? '') || !HH_MM_REGEX.test(b.endTime ?? '')) {
            return reply.code(400).send({ error: 'Format jam harus HH:mm (00:00 - 23:59).' });
        }
        if (!Array.isArray(b.daysOfWeek) || b.daysOfWeek.length === 0) {
            return reply.code(400).send({ error: 'Pilih minimal satu hari aktif.' });
        }
        const created = deps.repos.schedules.create({
            cameraId: b.cameraId,
            name: b.name?.trim() || 'Jadwal Rekam',
            daysOfWeek: b.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
            startTime: b.startTime,
            endTime: b.endTime,
            enabled: b.enabled ?? true,
        });
        await deps.recorder.reconcileSchedules();
        return reply.code(201).send(created);
    });
    app.put('/api/schedules/:id', async (req, reply) => {
        const b = req.body ?? {};
        if (b.startTime && !HH_MM_REGEX.test(b.startTime)) {
            return reply.code(400).send({ error: 'Format jam mulai tidak valid.' });
        }
        if (b.endTime && !HH_MM_REGEX.test(b.endTime)) {
            return reply.code(400).send({ error: 'Format jam selesai tidak valid.' });
        }
        const updated = deps.repos.schedules.update(req.params.id, b);
        if (!updated) {
            return reply.code(404).send({ error: 'Jadwal tidak ditemukan.' });
        }
        await deps.recorder.reconcileSchedules();
        return updated;
    });
    app.delete('/api/schedules/:id', async (req, reply) => {
        const ok = deps.repos.schedules.delete(req.params.id);
        if (!ok) {
            return reply.code(404).send({ error: 'Jadwal tidak ditemukan.' });
        }
        await deps.recorder.reconcileSchedules();
        return { deleted: true };
    });
}
