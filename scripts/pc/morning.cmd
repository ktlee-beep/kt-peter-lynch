@echo off
rem Weekday morning launcher, started by Windows Task Scheduler (\KT\KT-PeterLynch-Morning, 08:50 KST).
rem ASCII only on purpose: cmd.exe reads .cmd files in the OEM code page (CP949), not UTF-8.
rem   stream-collector : Toss websocket quotes (trade + orderbook, read-only) until 20:05 KST.
rem   Its small-cap slots come from the evening build (evening.cmd, 20:15 KST on the previous weekday);
rem   no picks are built here, so the collector starts right away.
rem Logs (gitignored): scripts\pc\morning.log, collector.log
cd /d "%~dp0..\.."
set "NODE=C:\Program Files\nodejs\node.exe"
>> scripts\pc\morning.log echo [%date% %time%] start
"%NODE%" scripts\backtest\stream-collector.mjs >> scripts\pc\collector.log 2>&1
>> scripts\pc\morning.log echo [%date% %time%] stream-collector exit=%errorlevel%
