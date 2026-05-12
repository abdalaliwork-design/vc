const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    EndBehaviorType,
    AudioPlayerStatus
} = require('@discordjs/voice');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const fs = require('fs');
const prism = require('prism-media');

chromium.use(stealth);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ─── متغيرات الجلسة ────────────────────────────────────────────────────────
let browser       = null;
let page          = null;
let ffmpegOut     = null;  // Grok → Discord
let ffmpegIn      = null;  // Discord → Grok
let connection    = null;
let player        = null;
let isTtsBusy     = false;
let sessionUserId = null;

const commands = [
    { name: 'start', description: 'يبدأ جلسة Grok ويربط الصوت 🎙️' },
    { name: 'stop',  description: 'يوقف الجلسة ويحرر الموارد 🛑'  }
];

// ─── دالة: بث صوت Grok → Discord ──────────────────────────────────────────
function startGrokAudio() {
    if (isTtsBusy) return;
    if (ffmpegOut) { ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }

    console.log('🔊 تشغيل FFmpeg: DiscordSink.monitor → Discord');

    ffmpegOut = spawn('ffmpeg', [
        '-loglevel', 'warning',
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

    ffmpegOut.stderr.on('data', d => console.error('[FFmpeg-OUT]', d.toString().trim()));
    ffmpegOut.on('error', err => {
        console.error('❌ FFmpeg-OUT error:', err.message);
        setTimeout(() => { if (connection && !isTtsBusy) startGrokAudio(); }, 2000);
    });
    ffmpegOut.on('exit', (code, sig) => {
        console.warn(`⚠️ FFmpeg-OUT exited code=${code} sig=${sig}`);
        if (connection && !isTtsBusy) setTimeout(() => startGrokAudio(), 1000);
    });

    const resource = createAudioResource(ffmpegOut.stdout, {
        inputType: StreamType.Raw,
        silencePaddingFrames: 5
    });

    player.play(resource);
    connection.subscribe(player);
}

// ─── دالة: استقبال صوت المستخدم → Grok (مستمر) ────────────────────────────
function setupVoiceInput(receiver) {
    receiver.speaking.on('start', (userId) => {
        if (userId !== sessionUserId) return;

        console.log('🎤 المستخدم يتكلم...');
        if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }

        const audioStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 300 }
        });

        const opusDecoder = new prism.opus.Decoder({
            rate: 48000, channels: 2, frameSize: 960
        });

        ffmpegIn = spawn('ffmpeg', [
            '-loglevel', 'warning',
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            '-i', 'pipe:0',
            '-f', 'pulse', 'DiscordMic'
        ]);

        ffmpegIn.stderr.on('data', d => console.error('[FFmpeg-IN]', d.toString().trim()));
        ffmpegIn.on('error', err => console.error('❌ FFmpeg-IN error:', err.message));

        audioStream.pipe(opusDecoder).pipe(ffmpegIn.stdin);

        audioStream.on('end', () => {
            console.log('🎤 المستخدم توقف');
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
        });
    });
}

// ─── دالة: TTS (نص → صوت في Discord) ─────────────────────────────────────
function speakText(text) {
    if (!player || !connection) return Promise.resolve();
    isTtsBusy = true;

    // إيقاف بث Grok مؤقتاً
    if (ffmpegOut) { ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }

    return new Promise((resolve) => {
        const isArabic = /[\u0600-\u06FF]/.test(text);
        const lang = isArabic ? 'ar' : 'en';

        console.log(`💬 TTS [${lang}]: ${text.substring(0, 60)}`);

        const espeak = spawn('espeak', ['-v', lang, '-s', '150', '--stdout', text]);
        const ffmpeg = spawn('ffmpeg', [
            '-loglevel', 'warning',
            '-f', 'wav', '-i', 'pipe:0',
            '-ar', '48000', '-ac', '2',
            '-f', 's16le', 'pipe:1'
        ]);

        espeak.stdout.pipe(ffmpeg.stdin);
        espeak.stderr.on('data', () => {});
        ffmpeg.stderr.on('data', d => console.error('[TTS-ffmpeg]', d.toString().trim()));

        espeak.on('error', err => {
            console.error('❌ espeak error:', err.message);
            isTtsBusy = false;
            if (connection) startGrokAudio();
            resolve();
        });

        const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
        player.play(resource);
        connection.subscribe(player);

        const onIdle = () => {
            console.log('✅ TTS انتهى → استئناف Grok');
            isTtsBusy = false;
            if (connection) startGrokAudio();
            resolve();
        };

        player.once(AudioPlayerStatus.Idle, onIdle);

        // ضمان: إذا فشل الـ player لأي سبب، نستأنف على أي حال
        ffmpeg.on('exit', () => {
            setTimeout(() => {
                if (isTtsBusy) {
                    isTtsBusy = false;
                    player.removeListener(AudioPlayerStatus.Idle, onIdle);
                    if (connection) startGrokAudio();
                    resolve();
                }
            }, 500);
        });
    });
}

// ─── حدث: جاهزية البوت ─────────────────────────────────────────────────────
// ✅ تم الإصلاح: clientReady (متوافق مع discord.js v14)
client.on('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    try {
        await client.application.commands.set(commands);
        console.log('✅ تم تسجيل الأوامر!');
    } catch (err) {
        console.error('❌ خطأ في تسجيل الأوامر:', err);
    }
});

// ─── حدث: رسائل النص → TTS ────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
    if (message.author.bot)      return;
    if (!connection || !player)  return;
    const text = message.content.trim();
    if (!text || text.startsWith('/')) return;

    try {
        await message.react('🔊');
        await speakText(text);
        await message.react('✅');
    } catch (err) {
        console.error('❌ TTS خطأ:', err.message);
        message.react('❌').catch(() => {});
    }
});

// ─── حدث: أوامر السلاش ─────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ━━━ /start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (interaction.commandName === 'start') {
        const voiceChannel = interaction.member?.voice.channel;

        if (!voiceChannel) return interaction.reply({ content: '❌ انضم لقناة صوتية أولاً!', ephemeral: true });
        if (browser)       return interaction.reply({ content: '⚠️ جلسة تعمل بالفعل!', ephemeral: true });

        await interaction.reply('🔄 جاري التهيئة...');
        sessionUserId = interaction.user.id;

        try {
            // 1. الانضمام للقناة الصوتية
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            // 2. مشغّل الصوت
            player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            player.on('error', err => {
                console.error('❌ Player error:', err.message);
                if (!isTtsBusy && connection) setTimeout(() => startGrokAudio(), 1500);
            });

            // 3. تشغيل المتصفح
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

            const context = await browser.newContext({ permissions: ['microphone'] });

            // 4. تحويل الكوكيز وتحميلها
            const convertCookies = (raw) => raw.map(c => ({
                name:     c.name,
                value:    c.value,
                domain:   c.domain,
                path:     c.path || '/',
                expires:  c.expirationDate ? Math.floor(c.expirationDate) : -1,
                httpOnly: c.httpOnly || false,
                secure:   c.secure || false,
                sameSite: (() => {
                    const s = (c.sameSite || '').toLowerCase();
                    if (s === 'strict') return 'Strict';
                    if (s === 'none' || s === 'no_restriction') return 'None';
                    return 'Lax';
                })()
            }));

            if (process.env.GROK_COOKIES) {
                try {
                    await context.addCookies(convertCookies(JSON.parse(process.env.GROK_COOKIES)));
                    console.log('✅ الكوكيز محملة من Railway.');
                } catch (e) {
                    console.error('❌ خطأ في GROK_COOKIES:', e.message);
                    interaction.channel.send('⚠️ خطأ في قراءة GROK_COOKIES!');
                }
            } else if (fs.existsSync('./cookies.json')) {
                await context.addCookies(convertCookies(JSON.parse(fs.readFileSync('./cookies.json', 'utf8'))));
                console.log('✅ الكوكيز محملة من الملف.');
            } else {
                interaction.channel.send('⚠️ لم يتم العثور على كوكيز.');
            }

            // 5. تحميل Grok
            page = await context.newPage();
            await page.goto('https://grok.com', { waitUntil: 'networkidle' });
            console.log('✅ Grok محمّل.');

            // 6. عند جاهزية الاتصال الصوتي
            connection.on(VoiceConnectionStatus.Ready, () => {
                console.log('✅ الاتصال الصوتي جاهز!');
                setupVoiceInput(connection.receiver);
                setTimeout(() => startGrokAudio(), 2000); // تأخير لتجنب race condition
            });

            connection.on(VoiceConnectionStatus.Disconnected, () => {
                console.warn('⚠️ انقطع الاتصال الصوتي');
            });

            await interaction.editReply(
                '✅ **الجلسة تعمل الآن!**\n' +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك → Grok\n' +
                '💬 **اكتب أي نص هنا** وسيُقرأ بصوت عالٍ في القناة'
            );

        } catch (error) {
            console.error('❌ فشل التشغيل:', error);
            await interaction.editReply('❌ فشل: ' + error.message);

            if (ffmpegOut)  { ffmpegOut.kill('SIGKILL');  ffmpegOut = null; }
            if (ffmpegIn)   { ffmpegIn.kill('SIGKILL');   ffmpegIn = null;  }
            if (browser)    { await browser.close().catch(() => {}); browser = null; page = null; }
            if (connection) { connection.destroy(); connection = null; }
            if (player)     { player.stop(); player = null; }
            isTtsBusy = false;
        }
    }

    // ━━━ /stop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (interaction.commandName === 'stop') {
        if (!browser) return interaction.reply({ content: '⚠️ لا توجد جلسة نشطة.', ephemeral: true });

        await interaction.reply('🛑 جاري الإيقاف...');

        if (ffmpegOut)  { ffmpegOut.kill('SIGKILL');  ffmpegOut = null;  }
        if (ffmpegIn)   { ffmpegIn.kill('SIGKILL');   ffmpegIn = null;   }
        if (browser)    { await browser.close().catch(() => {}); browser = null; page = null; }
        if (connection) { connection.destroy(); connection = null; }
        if (player)     { player.stop(); player = null; }
        isTtsBusy     = false;
        sessionUserId = null;

        await interaction.editReply('✅ تم إيقاف كل شيء بنجاح.');
    }
});

client.login(process.env.DISCORD_TOKEN);
