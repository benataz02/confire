@echo off
cd /d "%~dp0.."
start "confire web" powershell -NoExit -Command "bun dev:web"
start "confire server" powershell -NoExit -Command "bun dev:server"
start "confire agent" powershell -NoExit -Command "bun dev:agent"
