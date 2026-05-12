#!/bin/bash

echo "Cleaning up old locks..."
rm -f /tmp/.X99-lock
rm -rf /tmp/runtime-node/*
killall Xvfb pulseaudio x11vnc websockify 2>/dev/null || true
sleep 1

# ─── Xvfb ────────────────────────────────────────────────────────────────────
echo "Starting Xvfb (Virtual Display)..."
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -ac &

# Poll until display is ready instead of fixed sleep
for i in $(seq 1 20); do
    xdpyinfo -display :99 >/dev/null 2>&1 && break
    sleep 0.3
done
echo "✅ Xvfb ready"

# ─── PulseAudio ──────────────────────────────────────────────────────────────
echo "Starting PulseAudio..."
# ✅ Use -D (daemonize) — same as original that worked. --start breaks in containers.
pulseaudio -D --exit-idle-time=-1 --disallow-exit=1 --system=false

# Poll until socket is live instead of fixed sleep
echo "Waiting for PulseAudio socket..."
for i in $(seq 1 20); do
    pactl info >/dev/null 2>&1 && break
    sleep 0.3
done

if ! pactl info >/dev/null 2>&1; then
    echo "⚠️ PulseAudio slow — retrying once..."
    pulseaudio -D --exit-idle-time=-1 --disallow-exit=1 --system=false 2>/dev/null || true
    sleep 3
fi

if pactl info >/dev/null 2>&1; then
    echo "✅ PulseAudio ready"
else
    echo "❌ PulseAudio failed to start!"
    exit 1
fi

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
# ✅ format=s16le matches DiscordMic — avoids float32le mismatch Chrome sees
pactl load-module module-virtual-source \
    source_name=VirtualMic \
    master=DiscordMic.monitor \
    source_properties=device.description="VirtualMic" \
    rate=48000 channels=2 format=s16le

echo "Setting PulseAudio defaults..."
pactl set-default-sink DiscordSink
pactl set-default-source VirtualMic

# ✅ Inherited by Node.js AND Chrome (Playwright launches it as child process)
export PULSE_SINK=DiscordSink
export PULSE_SOURCE=VirtualMic
# ✅ 30ms buffer — critical for real-time voice, reduces lag
export PULSE_LATENCY_MSEC=30

echo "PulseAudio sources and sinks:"
pactl list short sources
pactl list short sinks

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
