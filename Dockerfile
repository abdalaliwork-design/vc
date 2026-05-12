FROM node:18-bullseye

# تحديث النظام وتثبيت الحزم الأساسية
RUN apt-get update && apt-get install -y \
    xvfb \
    pulseaudio \
    ffmpeg \
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
    && rm -rf /var/lib/apt/lists/*

# إصلاح مجلد X11
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# إضافة المستخدم node إلى مجموعة audio
RUN usermod -aG audio node

# إعداد مجلد runtime لـ PulseAudio
ENV XDG_RUNTIME_DIR=/tmp/runtime-node
RUN mkdir -p /tmp/runtime-node && chown -R node:node /tmp/runtime-node && chmod 700 /tmp/runtime-node

WORKDIR /app

COPY package*.json ./
RUN npm install

# تثبيت Playwright وتعيين مساره في مكان عام
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium
RUN npx playwright install-deps chromium
RUN chmod -R 777 /ms-playwright

COPY . .

RUN chmod +x entrypoint.sh && chown -R node:node /app

USER node

ENTRYPOINT ["./entrypoint.sh"]
