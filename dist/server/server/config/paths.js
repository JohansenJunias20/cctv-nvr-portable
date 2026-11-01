import fs from 'node:fs';
import path from 'node:path';
export function resolveAppPaths(baseDir = process.cwd()) {
    const dataDir = path.join(baseDir, 'data');
    const binDir = path.join(baseDir, 'bin');
    const recordingsDir = path.join(dataDir, 'recordings');
    const activeRecordingsDir = path.join(recordingsDir, 'active');
    const pendingRecordingsDir = path.join(recordingsDir, 'pending');
    const clientDistDir = path.join(baseDir, 'dist', 'client');
    for (const dir of [dataDir, binDir, recordingsDir, activeRecordingsDir, pendingRecordingsDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return {
        baseDir,
        dataDir,
        dbPath: path.join(dataDir, 'nvr.db'),
        binDir,
        recordingsDir,
        activeRecordingsDir,
        pendingRecordingsDir,
        clientDistDir,
    };
}
