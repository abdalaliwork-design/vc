#!/bin/bash

echo "Cleaning up old locks..."
# تنظيف ملفات القفل لتجنب أخطاء إعادة التشغيل المفاجئ
rm -f /tmp/.X99-lock
rm -rf /tmp/runtime-node/*
killall Xvfb pulseaudio 2>/dev/null || true

echo "Starting Xvfb (Virtual Display)..."
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
sleep 2 # الانتظار حتى يعمل Xvfb

echo "Starting PulseAudio..."
# تشغيل PulseAudio في وضع الـ Daemon كـ Non-root
pulseaudio -D --exit-idle-time=-1 --disallow-exit=1 --system=false
sleep 2 # الانتظار لتهيئة الصوت

echo "Creating Virtual Audio Sink (DiscordSink)..."
# إنشاء مخرج صوت وهمي
pactl load-module module-null-sink sink_name=DiscordSink sink_properties=device.description="DiscordSink"

# جعل هذا المخرج هو الافتراضي للنظام (ليذهب صوت المتصفح إليه مباشرة)
pactl set-default-sink DiscordSink

echo "Starting Node.js Bot..."
node bot.js
