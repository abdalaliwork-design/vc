const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-stealth')();
const { spawn } = require('child_process');
const fs = require('fs');

// تفعيل إضافة التخفي للمتصفح
chromium.use(stealth);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// متغيرات عامة لإدارة الجلسة
let browser = null;
let page = null;
let ffmpegProcess = null;
let connection = null;
let player = null;

client.on('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // --- أمر البدء ---
    if (message.content === '/start') {
        const voiceChannel = message.member?.voice.channel;
        if (!voiceChannel) {
            return message.reply('❌ يجب أن تكون في قناة صوتية أولاً!');
        }
        if (browser) {
            return message.reply('⚠️ جلسة Grok تعمل بالفعل!');
        }

        const msg = await message.reply('🔄 جاري بدء محرك الاستخراج وتهيئة المتصفح...');

        try {
            // 1. الاتصال بالقناة الصوتية لديسكورد
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });

            // 2. تشغيل المتصفح (Headless: false) داخل شاشة Xvfb الوهمية لضمان عمل الصوت
            browser = await chromium.launch({
                headless: false, 
                args:[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // مهم لتقليل استهلاك الرام في Railway
                    '--autoplay-policy=no-user-gesture-required' // السماح بتشغيل الصوت تلقائياً
                ]
            });

            const context = await browser.newContext();

            // 3. حقن الكوكيز الخاصة بتسجيل الدخول
            if (fs.existsSync('./cookies.json')) {
                const cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
                await context.addCookies(cookies);
            } else {
                message.channel.send('⚠️ تنبيه: ملف cookies.json غير موجود. قد يُطلب تسجيل الدخول يدوياً.');
            }

            // ضمان فتح Tab واحد فقط لتوفير استهلاك الرام (< 1GB)
            page = await context.newPage();
            await page.goto('https://twitter.com/i/grok', { waitUntil: 'networkidle' });

            // 4. تشغيل FFmpeg لسحب الصوت من الـ Monitor الخاص بـ DiscordSink
            // إعدادات مصممة خصيصاً لتقليل الـ Latency لأقل من ثانية
            ffmpegProcess = spawn('ffmpeg',[
                '-f', 'pulse',
                '-i', 'DiscordSink.monitor', // التقاط الصوت من المخرج الوهمي
                '-fflags', 'nobuffer',       // منع التخزين المؤقت لتسريع النقل
                '-flags', 'low_delay',       // فرض وضع الـ Low Delay
                '-ac', '2',                  // قنوات الصوت (Stereo)
                '-ar', '48000',              // معدل التردد الصوتي القياسي لديسكورد
                '-f', 's16le',               // صيغة الإخراج الخام
                '-acodec', 'pcm_s16le',
                'pipe:1'                     // إرسال الناتج إلى stdout
            ]);

            // 5. ربط مخرج FFmpeg بمحرك صوت ديسكورد
            player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            const resource = createAudioResource(ffmpegProcess.stdout, {
                inputType: StreamType.Raw,
            });

            player.play(resource);
            connection.subscribe(player);

            msg.edit('✅ **اكتمل الربط!** المتصفح في الخلفية يعمل والصوت يتم بثه الآن إلى القناة.');

        } catch (error) {
            console.error(error);
            msg.edit('❌ حدث خطأ أثناء تشغيل الجلسة.');
        }
    }

    // --- أمر الإيقاف ---
    if (message.content === '/stop') {
        if (!browser) return message.reply('⚠️ لا توجد جلسة تعمل حالياً.');

        message.reply('🛑 جاري إيقاف الجلسة وتفريغ الذاكرة (RAM)...');

        // إيقاف FFmpeg
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;
        }

        // إغلاق المتصفح تماماً
        if (browser) {
            await browser.close();
            browser = null;
            page = null;
        }

        // قطع الاتصال الصوتي
        if (connection) {
            connection.destroy();
            connection = null;
        }
        if (player) {
            player.stop();
            player = null;
        }

        message.channel.send('✅ تم إغلاق كل شيء بنجاح وتوفير الموارد.');
    }
});

// لا تنسَ إضافة DISCORD_TOKEN في إعدادات Railway (Variables)
client.login(process.env.DISCORD_TOKEN);
