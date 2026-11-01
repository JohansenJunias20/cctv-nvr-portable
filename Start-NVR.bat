@echo off
setlocal
title CCTV Ezviz ^& RTSP Local NVR
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"

if not exist "%NODE%" (
  echo [ERROR] node\node.exe tidak ditemukan. Ekstrak seluruh isi ZIP dulu, jangan jalankan dari dalam ZIP.
  pause
  exit /b 1
)

rem --- Firewall (sekali saja, butuh Administrator) agar HP/PC lain bisa membuka dashboard ---
netsh advfirewall firewall show rule name="CCTV NVR Node" >nul 2>nul
if errorlevel 1 (
  echo Membuka izin Windows Firewall untuk akses dari perangkat lain ^(klik Yes pada jendela UAC^)...
  powershell -NoProfile -Command "Start-Process cmd -Verb RunAs -Wait -ArgumentList '/c netsh advfirewall firewall add rule name=\"CCTV NVR Node\" dir=in action=allow program=\"%~dp0node\node.exe\" enable=yes profile=any & netsh advfirewall firewall add rule name=\"CCTV NVR go2rtc\" dir=in action=allow program=\"%~dp0bin\go2rtc.exe\" enable=yes profile=any'" 2>nul
)

echo Menjalankan CCTV Local NVR...
start "" /min cmd /c "timeout /t 4 >nul & start http://localhost:3800"
"%NODE%" dist\server\server\index.js
echo.
echo Server berhenti. Lihat pesan di atas jika ada error.
pause
