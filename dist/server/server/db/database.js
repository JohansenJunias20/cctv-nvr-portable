import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
export function createDatabase(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 554,
      username TEXT NOT NULL DEFAULT 'admin',
      password TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT 'generic',
      main_rtsp_url TEXT NOT NULL,
      sub_rtsp_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      name TEXT NOT NULL,
      days_of_week TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      camera_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      local_path TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL,
      drive_file_id TEXT,
      drive_folder_id TEXT,
      web_view_link TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
    CREATE INDEX IF NOT EXISTS idx_recordings_started_at ON recordings(started_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
    // Cameras are identified by MAC address (stable) rather than IP (changes with DHCP).
    const cameraColumns = db.prepare('PRAGMA table_info(cameras)').all();
    if (!cameraColumns.some((c) => c.name === 'mac_address')) {
        db.exec('ALTER TABLE cameras ADD COLUMN mac_address TEXT');
    }
    return db;
}
