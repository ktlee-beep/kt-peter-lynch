@echo off
rem Weekday evening launcher, started by Windows Task Scheduler (\KT\KT-PeterLynch-Evening, 20:15 KST).
rem ASCII only on purpose: cmd.exe reads .cmd files in the OEM code page (CP949), not UTF-8.
rem   universe-builder : next trading day's theme small-cap picks from Naver theme data, after the close (read-only).
rem   The morning collector uses the newest build made between the previous weekday 15:40 and 07:00 today.
rem Logs (gitignored): scripts\pc\evening.log, universe.log
cd /d "%~dp0..\.."
set "NODE=C:\Program Files\nodejs\node.exe"
>> scripts\pc\evening.log echo [%date% %time%] start
"%NODE%" scripts\backtest\universe-builder.mjs >> scripts\pc\universe.log 2>&1
>> scripts\pc\evening.log echo [%date% %time%] universe-builder exit=%errorlevel%
