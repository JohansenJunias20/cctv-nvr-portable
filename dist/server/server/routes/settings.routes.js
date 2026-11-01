const VALID_SEGMENT_MINUTES = new Set([5, 10, 15, 30]);
export function registerSettingsRoutes(app, deps) {
    function getPublicSettings() {
        const s = deps.repos.settings.get();
        return {
            segmentMinutes: s.segmentMinutes,
            maxRetentionDays: s.maxRetentionDays,
            maxDriveUsageGb: s.maxDriveUsageGb,
            minDriveFreeGb: s.minDriveFreeGb,
            maxLocalBufferGb: s.maxLocalBufferGb,
            hasLanPin: Boolean(s.lanPin),
            googleClientId: s.googleClientId ?? '',
            hasGoogleClientSecret: Boolean(s.googleClientSecret),
            googleConnected: deps.oauth.isConnected(),
            googleAccountEmail: s.googleAccountEmail,
            recommendedRedirectUri: `http://localhost:${deps.serverPort}/api/gdrive/callback`,
        };
    }
    app.get('/api/settings', async () => getPublicSettings());
    app.put('/api/settings', async (req, reply) => {
        const b = req.body ?? {};
        const patch = {};
        if (b.segmentMinutes !== undefined) {
            if (!VALID_SEGMENT_MINUTES.has(Number(b.segmentMinutes))) {
                return reply.code(400).send({ error: 'Durasi segmen harus 5, 10, 15, atau 30 menit.' });
            }
            patch.segmentMinutes = Number(b.segmentMinutes);
        }
        if (b.maxRetentionDays !== undefined) {
            patch.maxRetentionDays = Math.max(0, Number(b.maxRetentionDays));
        }
        if (b.maxDriveUsageGb !== undefined) {
            patch.maxDriveUsageGb = Math.max(0, Number(b.maxDriveUsageGb));
        }
        if (b.minDriveFreeGb !== undefined) {
            patch.minDriveFreeGb = Math.max(0, Number(b.minDriveFreeGb));
        }
        if (b.maxLocalBufferGb !== undefined) {
            patch.maxLocalBufferGb = Math.max(0.5, Number(b.maxLocalBufferGb));
        }
        if (b.clearLanPin) {
            patch.lanPin = null;
        }
        else if (typeof b.lanPin === 'string' && b.lanPin.trim().length > 0) {
            patch.lanPin = b.lanPin.trim();
        }
        if (typeof b.googleClientId === 'string') {
            patch.googleClientId = b.googleClientId.trim() || null;
        }
        if (typeof b.googleClientSecret === 'string' && b.googleClientSecret.trim().length > 0) {
            patch.googleClientSecret = b.googleClientSecret.trim();
        }
        deps.repos.settings.update(patch);
        deps.syncWorker.enforceLocalOfflineCap();
        return getPublicSettings();
    });
    app.get('/api/gdrive/auth-url', async (_req, reply) => {
        try {
            const redirectUri = `http://localhost:${deps.serverPort}/api/gdrive/callback`;
            const url = deps.oauth.getAuthUrl(redirectUri);
            return { url, redirectUri };
        }
        catch (err) {
            return reply
                .code(400)
                .send({ error: err instanceof Error ? err.message : 'Gagal membuat URL OAuth Google' });
        }
    });
    app.get('/api/gdrive/callback', async (req, reply) => {
        if (req.query.error || !req.query.code) {
            return reply.redirect('/?gdrive=error');
        }
        try {
            const redirectUri = `http://localhost:${deps.serverPort}/api/gdrive/callback`;
            await deps.oauth.handleCallback(req.query.code, redirectUri);
            deps.syncWorker.triggerSyncSoon();
            return reply.redirect('/?gdrive=connected');
        }
        catch {
            return reply.redirect('/?gdrive=error');
        }
    });
    app.post('/api/gdrive/disconnect', async () => {
        deps.oauth.disconnect();
        return { connected: false };
    });
    app.get('/api/gdrive/status', async () => {
        const s = deps.repos.settings.get();
        const connected = deps.oauth.isConnected();
        let driveLimitBytes = null;
        let driveUsageBytes = null;
        if (connected) {
            try {
                const quota = await deps.uploader.getDriveQuota();
                if (quota) {
                    driveLimitBytes = quota.limitBytes;
                    driveUsageBytes = quota.usageBytes;
                }
            }
            catch {
                // offline or token issue
            }
        }
        const recent = deps.repos.recordings.listRecent(500);
        return {
            connected,
            accountEmail: s.googleAccountEmail,
            driveLimitBytes,
            driveUsageBytes,
            cctvUploadedBytes: deps.repos.recordings.getTotalUploadedBytes(),
            localPendingBytes: deps.repos.recordings.getTotalLocalPendingBytes(),
            pendingCount: recent.filter((r) => r.status === 'pending' || r.status === 'uploading' || r.status === 'failed').length,
            uploadedCount: recent.filter((r) => r.status === 'uploaded').length,
        };
    });
}
