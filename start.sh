#!/bin/bash
# Exceed Attendance — Server Launcher
# Run this script to start the check-in/check-out system

echo "🔄 Stopping any existing server on port 3003..."
fuser -k 3003/tcp 2>/dev/null
kill -9 $(lsof -t -i:3003 2>/dev/null) 2>/dev/null
sleep 1

echo "✅ Starting Exceed Attendance server..."
cd "$(dirname "$0")"
node server.js
