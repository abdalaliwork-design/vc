FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
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
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
RUN usermod -aG audio node

ENV XDG_RUNTIME_DIR=/tmp/runtime-node
RUN mkdir -p /tmp/runtime-node && chown -R node:node /tmp/runtime-node && chmod 700 /tmp/runtime-node

WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium
RUN npx playwright install-deps chromium
RUN chmod -R 777 /ms-playwright

COPY . .
RUN chmod +x entrypoint.sh && chown -R node:node /app

# noVNC port
EXPOSE 6080
# VNC port
EXPOSE 5900

USER node
ENTRYPOINT ["./entrypoint.sh"]
