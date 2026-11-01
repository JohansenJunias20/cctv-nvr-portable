import crypto from 'node:crypto';
function mapCamera(row) {
    return {
        id: row.id,
        name: row.name,
        ipAddress: row.ip_address,
        macAddress: row.mac_address ?? null,
        port: row.port,
        username: row.username,
        password: row.password,
        brand: row.brand,
        mainRtspUrl: row.main_rtsp_url,
        subRtspUrl: row.sub_rtsp_url,
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function mapSchedule(row) {
    return {
        id: row.id,
        cameraId: row.camera_id,
        name: row.name,
        daysOfWeek: JSON.parse(row.days_of_week),
        startTime: row.start_time,
        endTime: row.end_time,
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
    };
}
function mapRecording(row) {
    return {
        id: row.id,
        cameraId: row.camera_id,
        cameraName: row.camera_name,
        fileName: row.file_name,
        localPath: row.local_path,
        sizeBytes: row.size_bytes,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        triggerType: row.trigger_type,
        status: row.status,
        driveFileId: row.drive_file_id,
        driveFolderId: row.drive_folder_id,
        webViewLink: row.web_view_link,
        retryCount: row.retry_count,
        errorMessage: row.error_message,
        createdAt: row.created_at,
    };
}
const SETTINGS_KEY = 'app_settings';
function createDefaultSettings() {
    return {
        segmentMinutes: 10,
        maxRetentionDays: 7,
        maxDriveUsageGb: 10,
        minDriveFreeGb: 1,
        maxLocalBufferGb: 10,
        lanPin: null,
        sessionSecret: crypto.randomBytes(32).toString('hex'),
        googleClientId: null,
        googleClientSecret: null,
        googleTokens: null,
        googleAccountEmail: null,
    };
}
export function createRepositories(db) {
    // Ensure default settings row exists
    const existingSettings = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(SETTINGS_KEY);
    if (!existingSettings) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(createDefaultSettings()));
    }
    const cameras = {
        list() {
            const rows = db.prepare('SELECT * FROM cameras ORDER BY created_at ASC').all();
            return rows.map(mapCamera);
        },
        getById(id) {
            const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
            return row ? mapCamera(row) : null;
        },
        create(input) {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            db.prepare(`INSERT INTO cameras (
          id, name, ip_address, mac_address, port, username, password, brand, main_rtsp_url, sub_rtsp_url, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.ipAddress, input.macAddress ?? null, input.port ?? 554, input.username ?? 'admin', input.password ?? '', input.brand ?? 'generic', input.mainRtspUrl, input.subRtspUrl ?? null, (input.enabled ?? true) ? 1 : 0, now, now);
            return this.getById(id);
        },
        update(id, input) {
            const current = this.getById(id);
            if (!current)
                return null;
            const now = new Date().toISOString();
            db.prepare(`UPDATE cameras SET
          name = ?, ip_address = ?, mac_address = ?, port = ?, username = ?, password = ?,
          brand = ?, main_rtsp_url = ?, sub_rtsp_url = ?, enabled = ?, updated_at = ?
        WHERE id = ?`).run(input.name ?? current.name, input.ipAddress ?? current.ipAddress, input.macAddress !== undefined ? input.macAddress : current.macAddress, input.port ?? current.port, input.username ?? current.username, input.password !== undefined ? input.password : current.password, input.brand ?? current.brand, input.mainRtspUrl ?? current.mainRtspUrl, input.subRtspUrl !== undefined ? input.subRtspUrl : current.subRtspUrl, (input.enabled !== undefined ? input.enabled : current.enabled) ? 1 : 0, now, id);
            return this.getById(id);
        },
        delete(id) {
            const res = db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
            return res.changes > 0;
        },
    };
    const schedules = {
        listAll() {
            const rows = db.prepare('SELECT * FROM schedules ORDER BY created_at ASC').all();
            return rows.map(mapSchedule);
        },
        listByCamera(cameraId) {
            const rows = db
                .prepare('SELECT * FROM schedules WHERE camera_id = ? ORDER BY created_at ASC')
                .all(cameraId);
            return rows.map(mapSchedule);
        },
        getById(id) {
            const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
            return row ? mapSchedule(row) : null;
        },
        create(input) {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            db.prepare(`INSERT INTO schedules (id, camera_id, name, days_of_week, start_time, end_time, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.cameraId, input.name, JSON.stringify(input.daysOfWeek), input.startTime, input.endTime, (input.enabled ?? true) ? 1 : 0, now);
            return this.getById(id);
        },
        update(id, input) {
            const current = this.getById(id);
            if (!current)
                return null;
            db.prepare(`UPDATE schedules SET name = ?, days_of_week = ?, start_time = ?, end_time = ?, enabled = ?
         WHERE id = ?`).run(input.name ?? current.name, JSON.stringify(input.daysOfWeek ?? current.daysOfWeek), input.startTime ?? current.startTime, input.endTime ?? current.endTime, (input.enabled !== undefined ? input.enabled : current.enabled) ? 1 : 0, id);
            return this.getById(id);
        },
        delete(id) {
            const res = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
            return res.changes > 0;
        },
    };
    const recordings = {
        create(input) {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            db.prepare(`INSERT INTO recordings (
          id, camera_id, camera_name, file_name, local_path, size_bytes,
          started_at, ended_at, trigger_type, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.cameraId, input.cameraName, input.fileName, input.localPath, input.sizeBytes, input.startedAt, input.endedAt ?? null, input.triggerType, input.status ?? 'pending', now);
            return this.getById(id);
        },
        getById(id) {
            const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
            return row ? mapRecording(row) : null;
        },
        getByFileName(fileName) {
            const row = db.prepare('SELECT * FROM recordings WHERE file_name = ?').get(fileName);
            return row ? mapRecording(row) : null;
        },
        getByLocalPath(localPath) {
            const row = db.prepare('SELECT * FROM recordings WHERE local_path = ?').get(localPath);
            return row ? mapRecording(row) : null;
        },
        listRecent(limit = 100) {
            const rows = db
                .prepare('SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?')
                .all(limit);
            return rows.map(mapRecording);
        },
        listPendingForUpload() {
            const rows = db
                .prepare(`SELECT * FROM recordings
           WHERE status IN ('pending', 'failed') AND local_path IS NOT NULL
           ORDER BY started_at ASC`)
                .all();
            return rows.map(mapRecording);
        },
        listLocalBufferOldestFirst() {
            const rows = db
                .prepare(`SELECT * FROM recordings
           WHERE status IN ('pending', 'failed') AND local_path IS NOT NULL
           ORDER BY started_at ASC`)
                .all();
            return rows.map(mapRecording);
        },
        listUploadedOldestFirst() {
            const rows = db
                .prepare(`SELECT * FROM recordings
           WHERE status = 'uploaded' AND drive_file_id IS NOT NULL
           ORDER BY started_at ASC`)
                .all();
            return rows.map(mapRecording);
        },
        markUploading(id) {
            db.prepare(`UPDATE recordings SET status = 'uploading', error_message = NULL WHERE id = ?`).run(id);
        },
        markUploaded(id, info) {
            db.prepare(`UPDATE recordings SET
          status = 'uploaded',
          local_path = NULL,
          drive_file_id = ?,
          drive_folder_id = ?,
          web_view_link = ?,
          error_message = NULL
         WHERE id = ?`).run(info.driveFileId, info.driveFolderId, info.webViewLink, id);
        },
        markFailed(id, errorMessage) {
            db.prepare(`UPDATE recordings SET
          status = 'failed',
          retry_count = retry_count + 1,
          error_message = ?
         WHERE id = ?`).run(errorMessage, id);
        },
        resetRetry(id) {
            const res = db
                .prepare(`UPDATE recordings SET status = 'pending', retry_count = 0, error_message = NULL
           WHERE id = ? AND local_path IS NOT NULL`)
                .run(id);
            return res.changes > 0;
        },
        deleteById(id) {
            const res = db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
            return res.changes > 0;
        },
        getTotalUploadedBytes() {
            const row = db
                .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM recordings WHERE status = 'uploaded'`)
                .get();
            return row.total;
        },
        getTotalLocalPendingBytes() {
            const row = db
                .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM recordings
           WHERE status IN ('pending', 'uploading', 'failed') AND local_path IS NOT NULL`)
                .get();
            return row.total;
        },
    };
    const settings = {
        get() {
            const row = db
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get(SETTINGS_KEY);
            return { ...createDefaultSettings(), ...JSON.parse(row.value) };
        },
        update(patch) {
            const merged = { ...this.get(), ...patch };
            db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(merged), SETTINGS_KEY);
            return merged;
        },
    };
    return { cameras, schedules, recordings, settings };
}
