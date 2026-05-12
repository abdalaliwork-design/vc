# استخدام قاعدة Node 18 Bullseye
FROM node:18-bullseye

# تحديث النظام وتثبيت الحزم الأساسية (Xvfb, PulseAudio, FFmpeg, Playwright Deps)
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

# إصلاح تحذير Xvfb الخاص بـ X11
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# إضافة المستخدم node (الافتراضي) إلى مجموعة audio
RUN usermod -aG audio node

# إنشاء بيئة تشغيل لـ PulseAudio لتجنب أخطاء الصلاحيات
ENV XDG_RUNTIME_DIR=/tmp/runtime-node
RUN mkdir -p /tmp/runtime-node && chown -R node:node /tmp/runtime-node && chmod 700 /tmp/runtime-node

# إعداد مسار العمل
WORKDIR /app

# نسخ ملفات الـ package وتثبيت الحزم
COPY package*.json ./
RUN npm install

# 🔴 الحل الجذري لمشكلة المتصفح 🔴
# إجبار Playwright على تثبيت المتصفح في مسار عام ليتمكن المستخدم node من قراءته
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium
RUN npx playwright install-deps chromium
RUN chmod -R 777 /ms-playwright

# نسخ باقي ملفات المشروع
COPY . .

# منح صلاحيات التنفيذ لسكريبت الدخول وتعديل ملكية الملفات
RUN chmod +x entrypoint.sh && chown -R node:node /app

# التحويل إلى المستخدم غير الجذري
USER node

# بدء سكريبت التشغيل
ENTRYPOINT ["./entrypoint.sh"]
