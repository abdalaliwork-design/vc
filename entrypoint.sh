#!/bin/bash
set -e

echo "Cleaning up old locks..."
rm -f /tmp/.X99-lock
rm -rf /tmp/runtime-node/*
killall Xvfb pulseaudio x11vnc websockify 2>/dev/null || true
sleep 1

# ─── Xvfb ────────────────────────────────────────────────────────────────────
echo "Starting Xvfb (Virtual Display)..."
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -ac &
XVFB_PID=$!

# Wait until Xvfb is actually accepting connections
for i in $(seq 1 20); do
    xdpyinfo -display :99 >/dev/null 2>&1 && break
    sleep 0.5
done
echo "✅ Xvfb ready"

# ─── PulseAudio ──────────────────────────────────────────────────────────────
echo "Starting PulseAudio..."

# Export socket path so ALL child processes (Node, Chrome) share the same server
export XDG_RUNTIME_DIR=/tmp/runtime-node
export PULSE_RUNTIME_PATH=/tmp/runtime-node/pulse
export PULSE_SERVER=unix:/tmp/runtime-node/pulse/native
mkdir -p "$PULSE_RUNTIME_PATH"

pulseaudio \
    --start \
    --exit-idle-time=-1 \
    --disallow-exit=1 \
    --disallow-module-loading=0 \
    --log-level=error \
    --system=false \
    --daemonize=yes

# Wait until PulseAudio socket is live (don't rely on sleep)
echo "Waiting for PulseAudio socket..."
for i in $(seq 1 30); do
    pactl info >/dev/null 2>&1 && break
    sleep 0.3
done
pactl info >/dev/null 2>&1 || { echo "❌ PulseAudio failed to start!"; exit 1; }
echo "✅ PulseAudio ready"

# ─── Virtual devices ─────────────────────────────────────────────────────────
echo "Creating Virtual Audio Sink (DiscordSink) — Grok audio plays here..."
pactl load-module module-null-sink \
    sink_name=DiscordSink \
    sink_properties=device.description="DiscordSink" \
    rate=48000 channels=2 format=s16le

echo "Creating Virtual Mic Sink (DiscordMic) — bot writes user audio here..."
pactl load-module module-null-sink \
    sink_name=DiscordMic \
    sink_properties=device.description="DiscordMic" \
    rate=48000 channels=2 format=s16le

echo "Creating VirtualMic source from DiscordMic.monitor..."
# ✅ format=s16le must match DiscordMic — avoids float32le/s16le mismatch Chrome sees
pactl load-module module-virtual-source \
    source_name=VirtualMic \
    master=DiscordMic.monitor \
    source_properties=device.description="VirtualMic" \
    rate=48000 channels=2 format=s16le

echo "Setting PulseAudio defaults..."
pactl set-default-sink DiscordSink
pactl set-default-source VirtualMic

# ✅ These env vars are inherited by Node.js and Chrome (Playwright)
export PULSE_SINK=DiscordSink
export PULSE_SOURCE=VirtualMic
# ✅ Low latency for real-time voice (30ms buffer)
export PULSE_LATENCY_MSEC=30

echo "PulseAudio sources and sinks:"
pactl list short sources
pactl list short sinks

# ─── Verify routing ───────────────────────────────────────────────────────────
DEFAULT_SINK=$(pactl get-default-sink 2>/dev/null || pactl info | grep 'Default Sink' | awk '{print $3}')
DEFAULT_SRC=$(pactl get-default-source 2>/dev/null || pactl info | grep 'Default Source' | awk '{print $3}')
echo "🔊 Default sink:   $DEFAULT_SINK"
echo "🎤 Default source: $DEFAULT_SRC"

if [ "$DEFAULT_SINK" != "DiscordSink" ]; then
    echo "⚠️  Default sink is not DiscordSink — forcing..."
    pacmd set-default-sink DiscordSink
fi
if [ "$DEFAULT_SRC" != "VirtualMic" ]; then
    echo "⚠️  Default source is not VirtualMic — forcing..."
    pacmd set-default-source VirtualMic
fi

# ─── noVNC Setup ─────────────────────────────────────────────────────────────
NOVNC_PORT=${NOVNC_PORT:-6080}
VNC_PORT=5900

echo "Starting x11vnc on port $VNC_PORT..."
x11vnc -display :99 \
    -nopw \
    -forever \
    -shared \
    -rfbport $VNC_PORT \
    -noxdamage \
    -quiet \
    -bg 2>/dev/null
sleep 1

echo "Starting noVNC on port $NOVNC_PORT..."
if [ -d "/opt/novnc" ]; then
    websockify --web /opt/novnc/utils/novnc_proxy --wrap-mode=ignore $NOVNC_PORT localhost:$VNC_PORT &
    echo "✅ noVNC ready → http://localhost:$NOVNC_PORT/vnc.html"
elif command -v websockify &>/dev/null; then
    NOVNC_SHARE=$(find /usr -name "vnc.html" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
    if [ -n "$NOVNC_SHARE" ]; then
        websockify --web "$NOVNC_SHARE" $NOVNC_PORT localhost:$VNC_PORT &
        echo "✅ noVNC ready → http://localhost:$NOVNC_PORT/vnc.html"
    else
        websockify $NOVNC_PORT localhost:$VNC_PORT &
        echo "✅ websockify VNC proxy on port $NOVNC_PORT (no web UI)"
    fi
else
    echo "⚠️  noVNC/websockify not installed — VNC only on port $VNC_PORT"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  🖥️  noVNC:  http://YOUR_HOST:$NOVNC_PORT/vnc.html?autoconnect=true&resize=scale&reconnect=true"
echo "  🖥️  VNC:    vnc://YOUR_HOST:$VNC_PORT"
echo "  🎤  VirtualMic source: DiscordMic.monitor → VirtualMic"
echo "  🔊  Grok audio sink:   DiscordSink"
echo "  🎤  Listening ONLY to user: 712321588342816879"
echo "═══════════════════════════════════════════"
echo ""

echo "Starting Node.js Bot..."
exec node bot.js
