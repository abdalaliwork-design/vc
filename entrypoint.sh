#!/bin/bash
set -e

echo "════════════════════════════════════════"
echo "  Grok ↔ Discord Voice Bridge"
echo "════════════════════════════════════════"

# ── Clean stale locks ─────────────────────────────────────────────────────────
echo "🧹 Cleaning up stale locks..."
rm -f /tmp/.X99-lock /tmp/.X100-lock
rm -rf /tmp/runtime-node/*
killall Xvfb pulseaudio x11vnc websockify chromium chromium-browser 2>/dev/null || true
sleep 1

# ── Virtual Display ───────────────────────────────────────────────────────────
echo "🖥️  Starting Xvfb (1920x1080)..."
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

for i in $(seq 1 30); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.3
done
echo "✅ Xvfb ready (PID $XVFB_PID)"

# ── PulseAudio ────────────────────────────────────────────────────────────────
echo "🔊 Starting PulseAudio..."
pulseaudio --start \
  --exit-idle-time=-1 \
  --disallow-exit=1 \
  --disallow-module-loading=0 \
  --system=false \
  --log-level=warn

for i in $(seq 1 30); do
  pactl info >/dev/null 2>&1 && break
  sleep 0.3
done

if ! pactl info >/dev/null 2>&1; then
  echo "⚠️  PulseAudio slow, retrying..."
  pulseaudio -D --exit-idle-time=-1 2>/dev/null || true
  sleep 3
fi

pactl info >/dev/null 2>&1 || { echo "❌ PulseAudio failed!"; exit 1; }
echo "✅ PulseAudio ready"

# ── Virtual Audio Cable Setup ─────────────────────────────────────────────────
echo "🔌 Creating virtual audio devices..."

# Sink 1: DiscordSink  → captures Grok's audio output
#          Its .monitor is what we'll pipe TO Discord's microphone
pactl load-module module-null-sink \
  sink_name=DiscordSink \
  sink_properties=device.description="GrokAudioOutput" \
  rate=48000 channels=2 format=s16le

# Sink 2: DiscordMic  → acts as a virtual microphone for Discord Web
pactl load-module module-null-sink \
  sink_name=DiscordMic \
  sink_properties=device.description="DiscordMicInput" \
  rate=48000 channels=2 format=s16le

# Virtual source that reads from DiscordMic.monitor
# → This is what the browser sees as "microphone"
pactl load-module module-virtual-source \
  source_name=VirtualMic \
  master=DiscordMic.monitor \
  source_properties=device.description="VirtualMicrophone" \
  rate=48000 channels=2 format=s16le

# Echo cancellation — removes YOUR voice from the mic feed
# Problem without this: Discord Web plays everyone's audio (including yours)
# through DiscordSink → loopback picks it up → sends it back as mic input → you hear yourself
#
# module-echo-cancel uses WebRTC AEC:
#   sink_master   = DiscordSink   → playback reference signal (what to subtract)
#   source_master = VirtualMic    → dirty mic signal (your voice leaks in here)
#   result        = VirtualMicAEC → Grok's voice only, your echo cancelled out
pactl load-module module-echo-cancel \
  sink_name=EchoCancelSink \
  sink_master=DiscordSink \
  source_name=VirtualMicAEC \
  source_master=VirtualMic \
  source_properties=device.description="VirtualMicrophoneAEC" \
  aec_method=webrtc \
  rate=48000 channels=2

# Route: Grok audio → DiscordSink → loopback → DiscordMic → VirtualMic → AEC → Discord Web
echo "🔀 Setting up audio routing..."
pactl set-default-sink   DiscordSink
pactl set-default-source VirtualMicAEC

export PULSE_SINK=DiscordSink
export PULSE_SOURCE=VirtualMicAEC
# ── Reduced from 80ms → 30ms to cut mic echo lag ─────────────────────────────
export PULSE_LATENCY_MSEC=30

echo ""
echo "📡 Audio devices:"
pactl list short sources | sed 's/^/   SOURCE  /'
pactl list short sinks   | sed 's/^/   SINK    /'
echo ""

# ── Start background audio loopback ──────────────────────────────────────────
# This pipes DiscordSink.monitor → DiscordMic (creating the virtual cable)
# --latency-msec=30 matches PULSE_LATENCY_MSEC above for tight sync
echo "🔁 Starting audio loopback (DiscordSink → VirtualMic)..."
pacat --record \
      --device=DiscordSink.monitor \
      --latency-msec=30 \
      --format=s16le --rate=48000 --channels=2 | \
pacat --playback \
      --device=DiscordMic \
      --latency-msec=30 \
      --format=s16le --rate=48000 --channels=2 &
LOOPBACK_PID=$!
echo "✅ Audio loopback running (PID $LOOPBACK_PID)"

# ── VNC / noVNC ───────────────────────────────────────────────────────────────
VNC_PORT=5900
NOVNC_PORT=${NOVNC_PORT:-6080}

echo "📺 Starting x11vnc..."
x11vnc -display :99 \
  -nopw -forever -shared \
  -rfbport $VNC_PORT \
  -noxdamage -quiet -bg 2>/dev/null
sleep 1

echo "🌐 Starting noVNC on port $NOVNC_PORT..."
if [ -d "/opt/novnc" ]; then
  websockify --web /opt/novnc \
    --wrap-mode=ignore \
    $NOVNC_PORT localhost:$VNC_PORT &
elif command -v websockify >/dev/null 2>&1; then
  NOVNC_SHARE=$(find /usr /opt -name "vnc.html" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo "")
  if [ -n "$NOVNC_SHARE" ]; then
    websockify --web "$NOVNC_SHARE" $NOVNC_PORT localhost:$VNC_PORT &
  else
    websockify $NOVNC_PORT localhost:$VNC_PORT &
  fi
else
  echo "⚠️  websockify not found — VNC only"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "  🖥️  noVNC  →  http://YOUR_HOST:$NOVNC_PORT/vnc.html?autoconnect=true&resize=scale"
echo "  📺  VNC    →  vnc://YOUR_HOST:$VNC_PORT"
echo ""
echo "  🔊  Grok audio output  →  DiscordSink (headless browser)"
echo "  🎤  Discord mic input  →  VirtualMic (via DiscordSink.monitor, 30ms latency)"
echo ""
echo "  🤖  Persona : ${PERSONA_NAME:-Alex}"
echo "  🔒  Access  : ${ALLOWED_USER_ID:-everyone}"
echo "════════════════════════════════════════════════════════"
echo ""

echo "🚀 Starting Node.js bot..."
exec node bot.js
