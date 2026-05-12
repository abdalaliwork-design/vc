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
const { PassThrough } = require('stream');
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
let browser        = null;
let page           = null;
let ffmpegOut      = null;
let ffmpegIn       = null;
let connection     = null;
let player         = null;
let grokPassthrough= null;   // ✅ Stream دائم لا يُغلق أبداً
let sessionUserId  = null;

const commands = [
    { name: 'start', description: 'يبدأ جلسة Grok ويربط الصوت 🎙️' },
    { name: 'stop',  description: 'يوقف الجلسة ويحرر الموارد 🛑'  }
];

// ─── دالة: بدء بث صوت Grok → Discord ─────────────────────────────────────
// ✅ الحل الجذري: FFmpeg يُضخّ في PassThrough دائم
// الـ Player يقرأ من PassThrough فلا يتوقف أبداً → لا Broken pipe
function startGrokAudio() {
    if (ffmpegOut) {
        ffmpegOut.stdout.unpipe();
        ffmpegOut.kill('SIGKILL');
        ffmpegOut = null;
    }

    console.log('🔊 تشغيل FFmpeg: DiscordSink.monitor → PassThrough → Discord');

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

    // ✅ يضخّ في PassThrough بدون إغلاقه عند انتهاء FFmpeg
    ffmpegOut.stdout.pipe(grokPassthrough, { end: false });

    ffmpegOut.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('Guessed Channel')) {
            console.error('[FFmpeg-OUT]', msg);
        }
    });

    ffmpegOut.on('error', err => {
        console.error('❌ FFmpeg-OUT error:', err.message);
        setTimeout(() => { if (connection) startGrokAudio(); }, 2000);
    });

    ffmpegOut.on('exit', (code, sig) => {
        if (sig !== 'SIGKILL') {
            console.warn(`⚠️ FFmpeg-OUT exited code=${code}, restarting...`);
            setTimeout(() => { if (connection) startGrokAudio(); }, 1000);
        }
    });
}

// ─── دالة: إعداد Player مرة واحدة فقط ────────────────────────────────────
function initPlayer() {
    grokPassthrough = new PassThrough();

    // كتابة صمت مبدئي (2 ثانية) لتجنب idle فوري
    const silence = Buffer.alloc(48000 * 2 * 2 * 2); // 2s @ 48kHz stereo 16-bit
    grokPassthrough.write(silence);

    player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    // ✅ PassThrough لا يُرسل EOF أبداً فالـ player يبقى Playing
    const resource = createAudioResource(grokPassthrough, {
        inputType: StreamType.Raw
    });

    player.play(resource);

    player.on('error', err => {
        console.error('❌ Player error:', err.message);
    });

    player.on(AudioPlayerStatus.Idle, () => {
        // لا يجب أن يحدث مع PassThrough، لكن كإجراء احترازي
        console.warn('⚠️ Player went Idle — reattaching resource');
        if (grokPassthrough && connection) {
            const newResource = createAudioResource(grokPassthrough, {
                inputType: StreamType.Raw
            });
            player.play(newResource);
        }
    });
}

// ─── دالة: TTS يكتب مباشرة لـ PulseAudio DiscordSink ─────────────────────
// ✅ لا يحتاج تبديل player أبداً — صوت espeak يدخل المنظومة كأنه صوت Grok
function speakText(text) {
    return new Promise((resolve) => {
        const isArabic = /[\u0600-\u06FF]/.test(text);
        const lang = isArabic ? 'ar' : 'en';

        console.log(`💬 TTS [${lang}]: ${text.substring(0, 60)}`);

        const espeak = spawn('espeak', ['-v', lang, '-s', '150', '--stdout', text]);
        const ffmpeg = spawn('ffmpeg', [
            '-loglevel', 'warning',
            '-f', 'wav',
            '-i', 'pipe:0',
            '-ar', '48000',
            '-ac', '2',
            '-f', 'pulse',
            'DiscordSink'        // ✅ يكتب مباشرة لـ DiscordSink
        ]);

        espeak.stdout.pipe(ffmpeg.stdin);

        espeak.stderr.on('data', () => {});
        ffmpeg.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg && !msg.includes('Guessed')) console.error('[TTS]', msg);
        });

        espeak.on('error', err => {
            console.error('❌ espeak error:', err.message);
            resolve();
        });
        ffmpeg.on('error', err => {
            console.error('❌ TTS-ffmpeg error:', err.message);
            resolve();
        });
        ffmpeg.on('exit', () => {
            console.log('✅ TTS انتهى');
            resolve();
        });
    });
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

        ffmpegIn.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg && !msg.includes('Guessed')) console.error('[FFmpeg-IN]', msg);
        });
        ffmpegIn.on('error', err => console.error('❌ FFmpeg-IN error:', err.message));

        audioStream.pipe(opusDecoder).pipe(ffmpegIn.stdin);

        audioStream.on('end', () => {
            console.log('🎤 المستخدم توقف');
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
        });
    });
}

// ─── حدث: جاهزية البوت ─────────────────────────────────────────────────────
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
    if (message.author.bot)     return;
    if (!connection || !player) return;

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
            // 1. إعداد Player مع PassThrough
            initPlayer();

            // 2. الانضمام للقناة الصوتية
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            connection.subscribe(player);

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

            // 4. تحويل وتحميل الكوكيز
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
                    console.error('❌ GROK_COOKIES error:', e.message);
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

                // ✅ بدء FFmpeg بعد ثانيتين لضمان استقرار PulseAudio
                setTimeout(() => startGrokAudio(), 2000);
            });

            connection.on(VoiceConnectionStatus.Disconnected, () => {
                console.warn('⚠️ انقطع الاتصال الصوتي');
            });

            await interaction.editReply(
                '✅ **الجلسة تعمل!**\n' +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك → Grok\n' +
                '💬 اكتب أي نص ليُقرأ بصوت في القناة'
            );

        } catch (error) {
            console.error('❌ فشل التشغيل:', error);
            await interaction.editReply('❌ فشل: ' + error.message);
            cleanupAll();
        }
    }

    // ━━━ /stop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (interaction.commandName === 'stop') {
        if (!browser) return interaction.reply({ content: '⚠️ لا توجد جلسة نشطة.', ephemeral: true });
        await interaction.reply('🛑 جاري الإيقاف...');
        cleanupAll();
        await interaction.editReply('✅ تم إيقاف كل شيء بنجاح.');
    }
});

// ─── دالة التنظيف الشامل ───────────────────────────────────────────────────
function cleanupAll() {
    if (ffmpegOut) {
        ffmpegOut.stdout.unpipe();
        ffmpegOut.kill('SIGKILL');
        ffmpegOut = null;
    }
    if (ffmpegIn)       { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
    if (grokPassthrough){ grokPassthrough.destroy(); grokPassthrough = null; }
    if (browser)        { browser.close().catch(() => {}); browser = null; page = null; }
    if (connection)     { connection.destroy(); connection = null; }
    if (player)         { player.stop(); player = null; }
    sessionUserId = null;
}

client.login(process.env.DISCORD_TOKEN);
