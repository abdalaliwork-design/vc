const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    EndBehaviorType
} = require('@discordjs/voice');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const fs = require('fs');
const prism = require('prism-media');

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
let ffmpegProcessOut = null;
let ffmpegProcessIn = null;
let connection = null;
let player = null;

// تعريف أوامر السلاش
const commands = [
    {
        name: 'start',
        description: 'يبدأ تشغيل متصفح Grok وبث الصوت إلى القناة الصوتية 🎙️',
    },
    {
        name: 'stop',
        description: 'يوقف الجلسة ويغلق المتصفح لتوفير الموارد 🛑',
    }
];

// ✅ الإصلاح: 'ready' بدلاً من 'clientReady'
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);

    try {
        console.log('🔄 جاري تسجيل أوامر السلاش (Slash Commands)...');
        await client.application.commands.set(commands);
        console.log('✅ تم تسجيل الأوامر بنجاح! ستظهر في ديسكورد الآن.');
    } catch (error) {
        console.error('❌ خطأ في تسجيل الأوامر:', error);
    }
});

// التعامل مع أوامر السلاش عند الضغط عليها
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // --- أمر البدء ---
    if (interaction.commandName === 'start') {
        const voiceChannel = interaction.member?.voice.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: '❌ يجب أن تكون في قناة صوتية أولاً!', ephemeral: true });
        }
        if (browser) {
            return interaction.reply({ content: '⚠️ جلسة Grok تعمل بالفعل!', ephemeral: true });
        }

        await interaction.reply('🔄 جاري بدء محرك الاستخراج وتهيئة المتصفح...');

        try {
            // 1. الاتصال بالقناة الصوتية لديسكورد
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            // 2. تشغيل المتصفح داخل شاشة Xvfb الوهمية
            browser = await chromium.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--autoplay-policy=no-user-gesture-required',
                    '--use-fake-ui-for-media-stream',
                    '--use-fake-device-for-media-stream'
                ]
            });

            const context = await browser.newContext({
                permissions: ['microphone']
            });

            // 3. دالة تحويل الكوكيز من صيغة Chrome إلى صيغة Playwright
            const convertCookies = (rawCookies) => {
                return rawCookies.map(cookie => {
                    let sameSite = 'Lax';
                    if (cookie.sameSite) {
                        const s = cookie.sameSite.toLowerCase();
                        if (s === 'strict') sameSite = 'Strict';
                        else if (s === 'lax') sameSite = 'Lax';
                        else if (s === 'none' || s === 'no_restriction') sameSite = 'None';
                    }
                    return {
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path || '/',
                        expires: cookie.expirationDate ? Math.floor(cookie.expirationDate) : -1,
                        httpOnly: cookie.httpOnly || false,
                        secure: cookie.secure || false,
                        sameSite: sameSite
                    };
                });
            };

            // 4. حقن الكوكيز
            let cookies = null;
            if (process.env.GROK_COOKIES) {
                try {
                    const rawCookies = JSON.parse(process.env.GROK_COOKIES);
                    cookies = convertCookies(rawCookies);
                    console.log('✅ تم جلب وتحويل الكوكيز من متغيرات Railway بنجاح.');
                } catch (err) {
                    console.error('❌ خطأ في تحليل GROK_COOKIES!', err);
                    interaction.channel.send('⚠️ خطأ في قراءة متغير GROK_COOKIES، تأكد من صحة الكود المنسوخ.');
                }
            } else if (fs.existsSync('./cookies.json')) {
                const rawCookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
                cookies = convertCookies(rawCookies);
                console.log('✅ تم جلب وتحويل الكوكيز من ملف cookies.json المحلي.');
            }

            if (cookies) {
                await context.addCookies(cookies);
            } else {
                interaction.channel.send('⚠️ تنبيه: لم يتم العثور على كوكيز. قد يُطلب تسجيل الدخول يدوياً.');
            }

            // 5. فتح صفحة Grok
            page = await context.newPage();
            await page.goto('https://grok.com', { waitUntil: 'networkidle' });

            // 6. ربط صوت Discord بالمتصفح (لإرسال صوتك إلى Grok)
            const receiver = connection.receiver;

            connection.on(VoiceConnectionStatus.Ready, () => {
                console.log('✅ اتصال الصوت جاهز!');

                const audioStream = receiver.subscribe(interaction.user.id, {
                    end: {
                        behavior: EndBehaviorType.AfterSilence,
                        duration: 100
                    }
                });

                const opusDecoder = new prism.opus.Decoder({
                    rate: 48000,
                    channels: 2,
                    frameSize: 960
                });

                ffmpegProcessIn = spawn('ffmpeg', [
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-i', 'pipe:0',
                    '-f', 'pulse',
                    'DiscordMic'
                ]);

                ffmpegProcessIn.stderr.on('data', (data) => {
                    // تجاهل stderr لتقليل الضوضاء في اللوج
                });

                audioStream.pipe(opusDecoder).pipe(ffmpegProcessIn.stdin);
                console.log('🎤 تم ربط صوتك بـ Grok!');
            });

            // 7. سحب صوت Grok من DiscordSink وإرساله لديسكورد
            ffmpegProcessOut = spawn('ffmpeg', [
                '-f', 'pulse',
                '-i', 'DiscordSink.monitor',
                '-fflags', 'nobuffer',
                '-flags', 'low_delay',
                '-ac', '2',
                '-ar', '48000',
                '-f', 's16le',
                '-acodec', 'pcm_s16le',
                'pipe:1'
            ]);

            ffmpegProcessOut.stderr.on('data', (data) => {
                // تجاهل stderr
            });

            player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            const resource = createAudioResource(ffmpegProcessOut.stdout, {
                inputType: StreamType.Raw,
            });

            player.play(resource);
            connection.subscribe(player);

            await interaction.editReply(
                '✅ **اكتمل الربط!** المتصفح يعمل على grok.com والصوت ثنائي الاتجاه يعمل الآن:\n' +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك → Grok'
            );

        } catch (error) {
            console.error('❌ خطأ في تشغيل الجلسة:', error);
            await interaction.editReply('❌ حدث خطأ أثناء تشغيل الجلسة: ' + error.message);

            // تنظيف عند الخطأ
            if (browser) { await browser.close(); browser = null; page = null; }
            if (connection) { connection.destroy(); connection = null; }
        }
    }

    // --- أمر الإيقاف ---
    if (interaction.commandName === 'stop') {
        if (!browser) {
            return interaction.reply({ content: '⚠️ لا توجد جلسة تعمل حالياً.', ephemeral: true });
        }

        await interaction.reply('🛑 جاري إيقاف الجلسة وتفريغ الذاكرة...');

        if (ffmpegProcessOut) { ffmpegProcessOut.kill('SIGKILL'); ffmpegProcessOut = null; }
        if (ffmpegProcessIn)  { ffmpegProcessIn.kill('SIGKILL');  ffmpegProcessIn = null;  }
        if (browser)          { await browser.close(); browser = null; page = null; }
        if (connection)       { connection.destroy(); connection = null; }
        if (player)           { player.stop(); player = null; }

        await interaction.editReply('✅ تم إغلاق كل شيء بنجاح وتوفير الموارد.');
    }
});

// تسجيل الدخول للبوت
client.login(process.env.DISCORD_TOKEN);
