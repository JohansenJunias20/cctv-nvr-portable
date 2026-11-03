# CCTV Ezviz & RTSP Local NVR - Rilis Portable

Repo ini khusus untuk **distribusi dan update otomatis (OTA)** aplikasi NVR. Isinya hanya halaman Releases; tidak ada kode sumber.

## Pasang di PC baru
1. Unduh `CCTV-NVR-Portable.zip` dari [rilis terbaru](../../releases/latest).
2. Ekstrak ke folder tetap (mis. `C:\CCTV-NVR`).
3. Klik dua kali `Start-NVR.bat`, lalu klik **Yes** pada jendela UAC (sekali saja).

NVR berjalan di latar belakang, otomatis menyala setiap Windows boot, dan memperbarui dirinya sendiri.

## Cara kerja update otomatis
Aplikasi mengecek `version.json` pada rilis terbaru (1 menit setelah nyala, lalu tiap 6 jam). Jika ada versi baru, paket diunduh, diverifikasi SHA-256, diterapkan, dan aplikasi dimulai ulang (rekaman terputus ±20 detik). Jika versi baru gagal start, versi lama dipulihkan otomatis.

| File rilis | Fungsi |
|---|---|
| `CCTV-NVR-Portable.zip` | Paket pemasangan baru |
| `update-app-<versi>.zip` | Update kecil (kode saja) |
| `update-full-<versi>.zip` | Update penuh (dipakai jika dependency/Node berubah) |
| `version.json` | Manifest versi + checksum |
