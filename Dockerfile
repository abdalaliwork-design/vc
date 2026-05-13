FROM node:20-bookworm-slim

LABEL maintainer="grok-discord-bridge"
LABEL description="Grok ↔ Discord voice bridge via browser automation + PulseAudio"

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Display
    xvfb x11vnc \
    # Audio
    pulseaudio pulseaudio-utils \
    # Chromium
    chromium \
    # noVNC / websockify
    novnc websockify \
    # Utilities
    curl wget ca-certificates dumb-init \
    # For Playwright browser deps
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

# ── noVNC setup ───────────────────────────────────────────────────────────────
RUN ln -sf /usr/share/novnc/utils/novnc_proxy /usr/bin/novnc_proxy 2>/dev/null || true

# ── App setup ─────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Install Playwright browsers (uses system chromium via env var)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

COPY bot.js ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# ── PulseAudio config ─────────────────────────────────────────────────────────
RUN mkdir -p /root/.config/pulse && cat > /root/.config/pulse/daemon.conf <<EOF
daemonize = no
allow-module-loading = yes
allow-exit = no
use-pid-file = yes
exit-idle-time = -1
flat-volumes = no
default-sample-format = s16le
default-sample-rate = 48000
default-sample-channels = 2
EOF

# ── Ports ─────────────────────────────────────────────────────────────────────
# 6080 = noVNC web UI
# 5900 = raw VNC
EXPOSE 6080 5900

# ── Run ───────────────────────────────────────────────────────────────────────
ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/entrypoint.sh"]
