#!/bin/bash

echo "Cleaning up old locks..."
rm -f /tmp/.X99-lock
rm -rf /tmp/runtime-node/*
killall Xvfb pulseaudio 2>/dev/null || true

echo "Starting Xvfb (Virtual Display)..."
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
sleep 2

echo "Starting PulseAudio..."
pulseaudio -D --exit-idle-time=-1 --disallow-exit=1 --system=false
sleep 2

echo "Creating Virtual Audio Sink (DiscordSink)..."
pactl load-module module-null-sink sink_name=DiscordSink sink_properties=device.description="DiscordSink"

echo "Creating Virtual Audio Source (DiscordMic)..."
pactl load-module module-null-sink sink_name=DiscordMic sink_properties=device.description="DiscordMic"

pactl set-default-sink DiscordSink
pactl set-default-source DiscordMic.monitor

echo "Starting Node.js Bot..."
node bot.js
