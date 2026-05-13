```dockerfile
FROM node:18-bullseye

# ─────────────────────────────────────────────────────────────
# System dependencies
# ─────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    make \
    g++ \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    espeak \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libcups2 \
    libxss1 \
    libxrandr2 \
    libasound2 \
    libgtk-3-0 \
    libgbm1 \
    dbus-x11 \
    sudo \
    x11vnc \
    novnc \
    websockify \
    net-tools \
    ca-certificates \
    wget \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────
# X11 runtime
# ─────────────────────────────────────────────────────────────
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# ─────────────────────────────────────────────────────────────
# Audio permissions
# ─────────────────────────────────────────────────────────────
RUN usermod -aG audio node

# ─────────────────────────────────────────────────────────────
# PulseAudio runtime
# ─────────────────────────────────────────────────────────────
ENV XDG_RUNTIME_DIR=/tmp/runtime-node

RUN mkdir -p /tmp/runtime-node \
    && chown -R node:node /tmp/runtime-node \
    && chmod 700 /tmp/runtime-node

# ─────────────────────────────────────────────────────────────
# Working directory
# ─────────────────────────────────────────────────────────────
WORKDIR /app

# ─────────────────────────────────────────────────────────────
# Package files
# ─────────────────────────────────────────────────────────────
COPY package*.json ./

# ─────────────────────────────────────────────────────────────
# Install node modules
# ─────────────────────────────────────────────────────────────
RUN npm install --legacy-peer-deps

# ─────────────────────────────────────────────────────────────
# Playwright browsers
# ─────────────────────────────────────────────────────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx playwright install chromium
RUN npx playwright install-deps chromium

RUN chmod -R 777 /ms-playwright

# ─────────────────────────────────────────────────────────────
# Copy app
# ─────────────────────────────────────────────────────────────
COPY . .

# ─────────────────────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────────────────────
RUN chmod +x entrypoint.sh \
    && chown -R node:node /app

# ─────────────────────────────────────────────────────────────
# Ports
# ─────────────────────────────────────────────────────────────
EXPOSE 6080
EXPOSE 5900

# ─────────────────────────────────────────────────────────────
# Environment
# ─────────────────────────────────────────────────────────────
ENV DISPLAY=:99
ENV PULSE_SINK=DiscordSink
ENV PULSE_SOURCE=VirtualMic

# IMPORTANT:
# Higher latency = more stable realtime audio inside Docker
ENV PULSE_LATENCY_MSEC=120

# ─────────────────────────────────────────────────────────────
# Use non-root user
# ─────────────────────────────────────────────────────────────
USER node

# ─────────────────────────────────────────────────────────────
# Start container
# ─────────────────────────────────────────────────────────────
ENTRYPOINT ["./entrypoint.sh"]
```
