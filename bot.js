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
const { addExtra } = require('playwright-extra');
const { chromium: playwrightChromium } = require('playwright');
const chromium = addExtra(playwrightChromium);
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const prism = require('prism-media');

chromium.use(stealth);

// ─── ALLOWED USER ID ────────────────────────────────────────────────────────
const ALLOWED_USER_ID = '712321588342816879';

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
let silenceInterval = null;
let isIdleBusy      = false;
let voiceInputReady = false;
let sessionUserId   = null;
let statusMessage   = null;
let statusChannel   = null;
let silenceTimeout  = null;

// 20 ms of silence at 48kHz stereo 16-bit PCM
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

        setImmediate(() => { isIdleBusy = false; });
    });
}

// ─── دالة: TTS ─────────────────────────────────────────────────────────────
function speakText(text) {
    return new Promise((resolve) => {
        const isArabic = /[\u0600-\u06FF]/.test(text);
        const lang = isArabic ? 'ar' : 'en';
        const tmpFile = `/tmp/tts_${Date.now()}.wav`;

        console.log(`💬 TTS [${lang}]: ${text.substring(0, 60)}`);

        const espeak = spawn('espeak', ['-v', lang, '-s', '150', '-w', tmpFile, text]);

        espeak.on('error', err => {
            console.error('❌ espeak error:', err.message);
            resolve();
        });

        espeak.on('exit', (code) => {
            if (code !== 0) { console.error(`❌ espeak exited ${code}`); return resolve(); }

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
                fs.unlink(tmpFile, () => {});
                resolve();
            });
        });
    });
}

// ─── دالة: تحويل الصوت إلى نص (Whisper/STT) ────────────────────────────────
function transcribeAudio(pcmBuffer) {
    return new Promise((resolve) => {
        const tmpPcm = `/tmp/stt_${Date.now()}.pcm`;
        const tmpWav = `/tmp/stt_${Date.now()}.wav`;

        fs.writeFile(tmpPcm, pcmBuffer, (err) => {
            if (err) { console.error('❌ STT write error:', err.message); return resolve(null); }

            // Convert raw PCM → WAV
            const toWav = spawn('ffmpeg', [
                '-loglevel', 'error',
                '-f', 's16le', '-ar', '48000', '-ac', '2',
                '-i', tmpPcm,
                '-ar', '16000', '-ac', '1',
                tmpWav
            ]);

            toWav.on('exit', (code) => {
                fs.unlink(tmpPcm, () => {});
                if (code !== 0) { return resolve(null); }

                // Use whisper.cpp or whisper if available, otherwise log raw info
                const whisper = spawn('whisper', [tmpWav, '--model', 'base', '--output_format', 'txt', '--output_dir', '/tmp'], { stdio: ['ignore', 'pipe', 'pipe'] });

                let output = '';
                whisper.stdout.on('data', d => { output += d.toString(); });
                whisper.stderr.on('data', d => { /* suppress */ });

                whisper.on('error', () => {
                    // whisper not installed — just log that audio was received
                    fs.unlink(tmpWav, () => {});
                    resolve(null);
                });

                whisper.on('exit', () => {
                    fs.unlink(tmpWav, () => {});
                    // Try reading txt output file
                    const txtFile = tmpWav.replace('.wav', '.txt');
                    if (fs.existsSync(txtFile)) {
                        const text = fs.readFileSync(txtFile, 'utf8').trim();
                        fs.unlink(txtFile, () => {});
                        resolve(text || null);
                    } else {
                        resolve(output.trim() || null);
                    }
                });
            });
        });
    });
}

// ─── دالة: استقبال صوت المستخدم → Grok ────────────────────────────────────
function setupVoiceInput(receiver) {
    console.log(`🎧 تهيئة استقبال صوت المستخدم — ID المسموح: ${ALLOWED_USER_ID}`);

    function listenToUser() {
        if (!connection || !sessionUserId) return;

        // ✅ Only listen to the ALLOWED user
        if (sessionUserId !== ALLOWED_USER_ID) {
            console.warn(`⛔ المستخدم ${sessionUserId} غير مصرح له — يجب أن يكون ${ALLOWED_USER_ID}`);
            return;
        }

        const audioStream = receiver.subscribe(ALLOWED_USER_ID, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 500 }
        });

        let hasData = false;
        const pcmChunks = [];

        const opusDecoder = new prism.opus.Decoder({
            rate: 48000, channels: 2, frameSize: 960
        });

        opusDecoder.on('data', (chunk) => {
            pcmChunks.push(chunk);
        });

        audioStream.on('data', () => {
            if (!hasData) {
                hasData = true;
                if (silenceTimeout) { clearTimeout(silenceTimeout); silenceTimeout = null; }
                console.log(`\n🎤 [SPEAKING] المستخدم ${ALLOWED_USER_ID} يتكلم...`);
                updateVoiceStatus(true);
            }
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

        audioStream.on('end', async () => {
            if (hasData) {
                console.log(`🎤 [STOPPED] المستخدم ${ALLOWED_USER_ID} توقف عن الكلام`);

                // ─── Log transcription if Whisper available ───────────────
                const pcmBuffer = Buffer.concat(pcmChunks);
                console.log(`📊 [AUDIO] حجم البيانات الصوتية: ${(pcmBuffer.length / 1024).toFixed(1)} KB`);

                transcribeAudio(pcmBuffer).then(text => {
                    if (text) {
                        console.log(`📝 [TRANSCRIPT] ما قاله المستخدم: "${text}"`);
                        if (statusChannel) {
                            statusChannel.send(`📝 سمعت: **${text}**`).catch(() => {});
                        }
                    } else {
                        console.log(`📝 [TRANSCRIPT] (Whisper غير متوفر — لا يمكن تحويل الصوت إلى نص)`);
                    }
                });

                silenceTimeout = setTimeout(() => updateVoiceStatus(false), 800);
            }
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
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
    console.log(`🔒 البوت يقبل فقط من المستخدم: ${ALLOWED_USER_ID}`);
    try {
        await client.application.commands.set(commands);
        console.log('✅ تم تسجيل الأوامر!');
    } catch (err) {
        console.error('❌ خطأ في تسجيل الأوامر:', err);
    }
});

// ─── حدث: رسائل النص → TTS ────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // ✅ Only respond to the allowed user's text messages
    if (message.author.id !== ALLOWED_USER_ID) {
        console.log(`⛔ [TEXT IGNORED] رسالة من ${message.author.tag} (${message.author.id}) — ليس المستخدم المصرح`);
        return;
    }

    if (!connection || !player) return;

    const text = message.content.trim();
    if (!text || text.startsWith('/')) return;

    console.log(`💬 [TEXT] المستخدم ${ALLOWED_USER_ID} كتب: "${text}"`);

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

    // ✅ Only allow the specific user to run commands
    if (interaction.user.id !== ALLOWED_USER_ID) {
        console.log(`⛔ [CMD BLOCKED] ${interaction.user.tag} (${interaction.user.id}) حاول تنفيذ /${interaction.commandName}`);
        return interaction.reply({ content: '❌ ليس لديك صلاحية استخدام هذا البوت.', ephemeral: true });
    }

    // ━━━ /start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (interaction.commandName === 'start') {
        const voiceChannel = interaction.member?.voice.channel;

        if (!voiceChannel) return interaction.reply({ content: '❌ انضم لقناة صوتية أولاً!', ephemeral: true });
        if (browser)       return interaction.reply({ content: '⚠️ جلسة تعمل بالفعل!', ephemeral: true });

        await interaction.reply('🔄 جاري التهيئة...');
        sessionUserId = ALLOWED_USER_ID; // Always use the fixed allowed user ID
        statusChannel = interaction.channel;
        statusMessage = null;

        console.log(`🚀 بدء الجلسة للمستخدم: ${ALLOWED_USER_ID}`);

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

            if (connection.state.status === VoiceConnectionStatus.Ready) {
                onReady();
            } else {
                voiceReadyTimer = setTimeout(() => {
                    if (!voiceInputReady && connection) onReady(true);
                }, 5000);
            }

            connection.on(VoiceConnectionStatus.Disconnected, () => {
                console.warn('⚠️ انقطع الاتصال الصوتي');
            });

            await interaction.editReply(
                '✅ **الجلسة تعمل!**\n' +
                `🔒 يستمع فقط للمستخدم: <@${ALLOWED_USER_ID}>\n` +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك → Grok\n' +
                '💬 اكتب أي نص ليُقرأ بصوت في القناة'
            );

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
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    voiceInputReady = false;
    if (ffmpegOut)       { ffmpegOut.stdout.unpipe(); ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }
    if (ffmpegIn)        { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
    if (grokPassthrough) { grokPassthrough.destroy(); grokPassthrough = null; }
    if (browser)         { browser.close().catch(() => {}); browser = null; page = null; }
    if (connection)      { connection.destroy(); connection = null; }
    if (player)          { player.stop(); player = null; }
    isIdleBusy    = false;
    sessionUserId = null;
    statusMessage = null;
    statusChannel = null;
    console.log('🧹 تم تنظيف جميع الموارد');
}

client.login(process.env.DISCORD_TOKEN);
