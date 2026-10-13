@echo off
rem Weekday morning launcher, started by Windows Task Scheduler (\KT\KT-PeterLynch-Morning, 08:50 KST).
rem ASCII only on purpose: cmd.exe reads .cmd files in the OEM code page (CP949), not UTF-8.
rem   1) universe-builder : theme small-cap picks from Naver theme data (read-only)
rem   2) stream-collector : Toss websocket quotes (trade + orderbook, read-only) until 20:05 KST
rem Logs (gitignored): scripts\pc\morning.log, universe.log, collector.log
cd /d "%~dp0..\.."
set "NODE=C:\Program Files\nodejs\node.exe"
echo [%date% %time%] start>> scripts\pc\morning.log
"%NODE%" scripts\backtest\universe-builder.mjs >> scripts\pc\universe.log 2>&1
echo [%date% %time%] universe-builder exit=%errorlevel%>> scripts\pc\morning.log
"%NODE%" scripts\backtest\stream-collector.mjs >> scripts\pc\collector.log 2>&1
echo [%date% %time%] stream-collector exit=%errorlevel%>> scripts\pc\morning.log
