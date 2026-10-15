@echo off
cd /d "%~dp0"
echo NeckCare dev server: http://localhost:5173
echo Press Ctrl+C in this window to stop.
start "" http://localhost:5173
python server.py 5173
