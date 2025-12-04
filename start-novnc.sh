#!/bin/bash
set -e

# Start Xvfb on display :1
XVFB_DISPLAY=:1
SCREEN_RES=${SCREEN_RES:-1280x720x24}

echo "Starting Xvfb on ${XVFB_DISPLAY} with resolution ${SCREEN_RES}"
# Remove stale X lock files if present (helps when container restarts quickly)
if [ -f "/tmp/.X1-lock" ]; then
	echo "Removing stale /tmp/.X1-lock"
	rm -f /tmp/.X1-lock || true
fi
if [ -e "/tmp/.X11-unix/X1" ]; then
	echo "Removing stale /tmp/.X11-unix/X1"
	rm -f /tmp/.X11-unix/X1 || true
fi

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

# Wait longer to ensure X server and desktop are fully ready
echo "Waiting for X server to be fully ready..."
sleep 3

# Verify X server is responding
if xdpyinfo -display ${DISPLAY} >/dev/null 2>&1; then
  echo "X server is ready on ${DISPLAY}"
else
  echo "WARNING: X server may not be fully ready"
fi

# Now start the Node server
echo "Starting Node server with DISPLAY=${DISPLAY}"
node server.js

# If node exits, clean up background processes
kill ${WEBSOCKIFY_PID} || true
kill ${X11VNC_PID} || true
kill ${XVFB_PID} || true
