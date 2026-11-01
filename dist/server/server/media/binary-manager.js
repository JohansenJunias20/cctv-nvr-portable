import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import ffmpegStatic from 'ffmpeg-static';
function resolveFfmpegStaticPath() {
    const candidate = typeof ffmpegStatic === 'string'
        ? ffmpegStatic
        : ffmpegStatic?.default;
    if (!candidate || !fs.existsSync(candidate)) {
        throw new Error('Binary ffmpeg-static tidak ditemukan. Jalankan npm install kembali.');
    }
    return candidate;
}
export async function ensureMediaBinaries(binDir) {
    fs.mkdirSync(binDir, { recursive: true });
    const ffmpegPath = resolveFfmpegStaticPath();
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'go2rtc.exe' : 'go2rtc';
    const go2rtcPath = path.join(binDir, exeName);
    if (fs.existsSync(go2rtcPath) && fs.statSync(go2rtcPath).size > 1_000_000) {
        return { ffmpegPath, go2rtcPath };
    }
    const downloadUrl = isWin
        ? 'https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_win64.zip'
        : process.platform === 'darwin'
            ? 'https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_mac_amd64.zip'
            : 'https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_amd64';
    const response = await fetch(downloadUrl, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Gagal mengunduh go2rtc (${response.status} ${response.statusText})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (downloadUrl.endsWith('.zip')) {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find((e) => e.entryName.endsWith(exeName));
        if (!entry) {
            throw new Error(`Arsip go2rtc tidak memuat ${exeName}`);
        }
        fs.writeFileSync(go2rtcPath, entry.getData());
    }
    else {
        fs.writeFileSync(go2rtcPath, buffer);
    }
    if (!isWin) {
        fs.chmodSync(go2rtcPath, 0o755);
    }
    return { ffmpegPath, go2rtcPath };
}
