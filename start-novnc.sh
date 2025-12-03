#!/bin/bash
set -e

# Start Xvfb on display :1
XVFB_DISPLAY=:1
SCREEN_RES=${SCREEN_RES:-1280x720x24}

echo "Starting Xvfb on ${XVFB_DISPLAY} with resolution ${SCREEN_RES}"
Xvfb ${XVFB_DISPLAY} -screen 0 ${SCREEN_RES} &
XVFB_PID=$!

export DISPLAY=${XVFB_DISPLAY}

# Start a lightweight window manager
echo "Starting fluxbox"
fluxbox >/dev/null 2>&1 &

# Start x11vnc to serve the DISPLAY on port 5900
echo "Starting x11vnc"
# -nopw (no password), -forever (keep running), -shared (allow multiple clients)
x11vnc -display ${DISPLAY} -nopw -forever -shared -rfbport 5900 >/dev/null 2>&1 &
X11VNC_PID=$!

# Start websockify (noVNC) to expose VNC over WebSockets on port 6080
echo "Starting websockify (noVNC bridge) on port 6080 -> localhost:5900"
# Using websockify from pip
websockify --web=/usr/src/app/noVNC 6080 localhost:5900 >/dev/null 2>&1 &
WEBSOCKIFY_PID=$!

# Slight delay to ensure desktop is ready
sleep 1

# Now start the Node server
echo "Starting Node server"
node server.js

# If node exits, clean up background processes
kill ${WEBSOCKIFY_PID} || true
kill ${X11VNC_PID} || true
kill ${XVFB_PID} || true
