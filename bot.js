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
let browser         = null;
let page            = null;
let ffmpegOut       = null;
let ffmpegIn        = null;
let connection      = null;
let player          = null;
let grokPassthrough = null;
let silenceInterval = null;   // ✅ keeps stream alive between FFmpeg chunks
let isIdleBusy      = false;  // ✅ re-entrancy guard for Idle handler
let voiceInputReady = false;  // ✅ module-level guard against double-init
let sessionUserId   = null;
let statusMessage   = null;   // live voice indicator message
let statusChannel   = null;   // channel to post indicator in
let silenceTimeout  = null;   // debounce for going back to silent

// 20 ms of silence at 48kHz stereo 16-bit PCM  (960 frames × 2 ch × 2 bytes)
const SILENCE_FRAME = Buffer.alloc(960 * 2 * 2);

const commands = [
    { name: 'start', description: 'يبدأ جلسة Grok ويربط الصوت 🎙️' },
    { name: 'stop',  description: 'يوقف الجلسة ويحرر الموارد 🛑'  }
];

// ─── دالة: تحديث مؤشر الصوت ────────────────────────────────────────────────
async function updateVoiceStatus(speaking) {
    if (!statusChannel) return;
    const content = speaking
        ? '🟢 **صوتك وصل** — البوت يسمعك الآن 🎤'
        : '🔴 **لا يوجد صوت** — تحدث في القناة الصوتية 🔇';
    try {
        if (statusMessage) {
            await statusMessage.edit(content);
        } else {
            statusMessage = await statusChannel.send(content);
        }
    } catch (e) {
        console.error('❌ updateVoiceStatus:', e.message);
    }
}


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
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-af', 'aresample=async=1000',
        '-ac', '2',
        '-ar', '48000',
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        'pipe:1'
    ]);

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
    grokPassthrough = new PassThrough({ highWaterMark: 96000 });

    // ✅ pump silence every 20 ms so the stream never runs dry
    silenceInterval = setInterval(() => {
        if (grokPassthrough && !grokPassthrough.destroyed) {
            grokPassthrough.write(SILENCE_FRAME);
        }
    }, 20);

    player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    const resource = createAudioResource(grokPassthrough, {
        inputType: StreamType.Raw
    });

    player.play(resource);

    player.on('error', err => {
        console.error('❌ Player error:', err.message);
    });

    // ✅ Guard prevents the Idle → play → Idle crash loop
    player.on(AudioPlayerStatus.Idle, () => {
        if (isIdleBusy || !grokPassthrough || !connection) return;
        isIdleBusy = true;

        console.warn('⚠️ Player went Idle — reattaching resource');
        try {
            const newResource = createAudioResource(grokPassthrough, {
                inputType: StreamType.Raw
            });
            player.play(newResource);
        } catch (e) {
            console.error('❌ Failed to reattach resource:', e.message);
        }

        // Release guard after one event-loop tick so rapid re-fires are swallowed
        setImmediate(() => { isIdleBusy = false; });
    });
}

// ─── دالة: TTS يكتب مباشرة لـ PulseAudio DiscordSink ─────────────────────
function speakText(text) {
    return new Promise((resolve) => {
        const isArabic = /[\u0600-\u06FF]/.test(text);
        const lang = isArabic ? 'ar' : 'en';
        const tmpFile = `/tmp/tts_${Date.now()}.wav`;

        console.log(`💬 TTS [${lang}]: ${text.substring(0, 60)}`);

        // Step 1: espeak writes a complete WAV file (avoids pipe header corruption)
        const espeak = spawn('espeak', ['-v', lang, '-s', '150', '-w', tmpFile, text]);

        espeak.on('error', err => {
            console.error('❌ espeak error:', err.message);
            resolve();
        });

        espeak.on('exit', (code) => {
            if (code !== 0) { console.error(`❌ espeak exited ${code}`); return resolve(); }

            // Step 2: ffmpeg reads the complete file — no header issues
            const ffmpeg = spawn('ffmpeg', [
                '-loglevel', 'error',
                '-i', tmpFile,
                '-ar', '48000',
                '-ac', '2',
                '-f', 'pulse',
                'DiscordSink'
            ]);

            ffmpeg.stderr.on('data', d => {
                const msg = d.toString().trim();
                if (msg) console.error('[TTS]', msg);
            });

            ffmpeg.on('error', err => {
                console.error('❌ TTS-ffmpeg error:', err.message);
                fs.unlink(tmpFile, () => {});
                resolve();
            });

            ffmpeg.on('exit', () => {
                console.log('✅ TTS انتهى');
                fs.unlink(tmpFile, () => {}); // clean up temp file
                resolve();
            });
        });
    });
}

// ─── دالة: استقبال صوت المستخدم → Grok ────────────────────────────────────
function setupVoiceInput(receiver) {
    console.log('🎧 تهيئة استقبال صوت المستخدم...');

    function listenToUser() {
        if (!connection || !sessionUserId) return;

        const audioStream = receiver.subscribe(sessionUserId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 500 }
        });

        let hasData = false;

        audioStream.on('data', () => {
            if (!hasData) {
                hasData = true;
                if (silenceTimeout) { clearTimeout(silenceTimeout); silenceTimeout = null; }
                console.log('🎤 المستخدم يتكلم...');
                updateVoiceStatus(true);
            }
        });

        const opusDecoder = new prism.opus.Decoder({
            rate: 48000, channels: 2, frameSize: 960
        });

        if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }

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
            if (hasData) {
                console.log('🎤 المستخدم توقف');
                silenceTimeout = setTimeout(() => updateVoiceStatus(false), 800);
            }
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
            // Re-subscribe immediately to catch the next utterance
            setTimeout(() => listenToUser(), 100);
        });

        audioStream.on('error', () => {
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
            setTimeout(() => listenToUser(), 500);
        });
    }

    listenToUser();
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
        statusChannel = interaction.channel;
        statusMessage = null;

        try {
            initPlayer();

            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            connection.subscribe(player);

            browser = await chromium.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--autoplay-policy=no-user-gesture-required',
                    '--use-fake-ui-for-media-stream',
                    // NOTE: do NOT use --use-fake-device-for-media-stream
                    // that replaces PulseAudio with a silent fake device
                ]
            });

            const context = await browser.newContext({ permissions: ['microphone'] });

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

            page = await context.newPage();
            await page.goto('https://grok.com', { waitUntil: 'networkidle' });
            console.log('✅ Grok محمّل.');

            let voiceReadyTimer = null;
            const onReady = (forced = false) => {
                if (voiceInputReady) return;
                voiceInputReady = true;
                if (voiceReadyTimer) { clearTimeout(voiceReadyTimer); voiceReadyTimer = null; }
                if (forced) console.warn('⚠️ Ready لم يصل — تهيئة إجبارية');
                else        console.log('✅ الاتصال الصوتي جاهز!');
                setupVoiceInput(connection.receiver);
                setTimeout(() => startGrokAudio(), 2000);
            };

            connection.on(VoiceConnectionStatus.Ready, onReady);

            // If already Ready before listener was attached, fire immediately
            if (connection.state.status === VoiceConnectionStatus.Ready) {
                onReady();
            } else {
                // Fallback: force-init after 5 s regardless
                voiceReadyTimer = setTimeout(() => {
                    if (!voiceInputReady && connection) onReady(true);
                }, 5000);
            }

            connection.on(VoiceConnectionStatus.Disconnected, () => {
                console.warn('⚠️ انقطع الاتصال الصوتي');
            });

            await interaction.editReply(
                '✅ **الجلسة تعمل!**\n' +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك → Grok\n' +
                '💬 اكتب أي نص ليُقرأ بصوت في القناة'
            );

            // post the live voice indicator
            await updateVoiceStatus(false);

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
    if (silenceTimeout)  { clearTimeout(silenceTimeout); silenceTimeout = null; }
    if (silenceInterval)  { clearInterval(silenceInterval); silenceInterval = null; }
    voiceInputReady = false;
    if (ffmpegOut)        { ffmpegOut.stdout.unpipe(); ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }
    if (ffmpegIn)         { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
    if (grokPassthrough)  { grokPassthrough.destroy(); grokPassthrough = null; }
    if (browser)          { browser.close().catch(() => {}); browser = null; page = null; }
    if (connection)       { connection.destroy(); connection = null; }
    if (player)           { player.stop(); player = null; }
    isIdleBusy    = false;
    sessionUserId = null;
    statusMessage = null;
    statusChannel = null;
}

client.login(process.env.DISCORD_TOKEN);
