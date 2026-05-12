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

const ALLOWED_USER_ID = '712321588342816879';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

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
let isSendingToGrok = false;

const SILENCE_FRAME = Buffer.alloc(960 * 2 * 2);

const commands = [
    { name: 'start', description: 'يبدأ جلسة Grok ويربط الصوت' },
    { name: 'stop',  description: 'يوقف الجلسة ويحرر الموارد'  }
];

async function updateVoiceStatus(speaking) {
    if (!statusChannel) return;
    const content = speaking
        ? '🟢 **صوتك وصل** — البوت يسمعك الآن 🎤'
        : '🔴 **لا يوجد صوت** — تحدث في القناة الصوتية 🔇';
    try {
        if (statusMessage) await statusMessage.edit(content);
        else statusMessage = await statusChannel.send(content);
    } catch (e) { console.error('❌ updateVoiceStatus:', e.message); }
}

// ─── Send typed Discord message → Grok's text box ────────────────────────────
async function sendTextToGrok(text) {
    if (!page || isSendingToGrok) return;
    isSendingToGrok = true;
    console.log(`📨 [GROK] إرسال: "${text}"`);
    try {
        const inputSelectors = [
            'textarea[placeholder]',
            'div[contenteditable="true"]',
            '[data-testid="chat-input"]',
            'textarea'
        ];
        let inputEl = null;
        for (const sel of inputSelectors) {
            try {
                inputEl = await page.waitForSelector(sel, { timeout: 3000 });
                if (inputEl) { console.log(`✅ وجد المربع: ${sel}`); break; }
            } catch { /* try next */ }
        }
        if (!inputEl) { console.error('❌ لم يتم العثور على مربع الإدخال'); isSendingToGrok = false; return; }
        await inputEl.click();
        await page.keyboard.type(text, { delay: 30 });
        await page.keyboard.press('Enter');
        console.log('✅ [GROK] تم الإرسال — Grok سيرد بصوته');
    } catch (err) {
        console.error('❌ sendTextToGrok:', err.message);
    } finally {
        isSendingToGrok = false;
    }
}

// ─── Capture Grok audio output → Discord ─────────────────────────────────────
function startGrokAudio() {
    if (ffmpegOut) { ffmpegOut.stdout.unpipe(); ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }
    console.log('🔊 FFmpeg: DiscordSink.monitor → Discord');
    ffmpegOut = spawn('ffmpeg', [
        '-loglevel', 'warning',
        '-f', 'pulse', '-i', 'DiscordSink.monitor',
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-af', 'aresample=async=1000',
        '-ac', '2', '-ar', '48000',
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'
    ]);
    ffmpegOut.stdout.pipe(grokPassthrough, { end: false });
    ffmpegOut.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('Guessed Channel')) console.error('[FFmpeg-OUT]', msg);
    });
    ffmpegOut.on('error', err => { console.error('❌ FFmpeg-OUT:', err.message); setTimeout(() => { if (connection) startGrokAudio(); }, 2000); });
    ffmpegOut.on('exit', (code, sig) => { if (sig !== 'SIGKILL') { console.warn(`⚠️ FFmpeg-OUT exit ${code}, restarting`); setTimeout(() => { if (connection) startGrokAudio(); }, 1000); } });
}

function initPlayer() {
    grokPassthrough = new PassThrough({ highWaterMark: 96000 });
    silenceInterval = setInterval(() => {
        if (grokPassthrough && !grokPassthrough.destroyed) grokPassthrough.write(SILENCE_FRAME);
    }, 20);
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.play(createAudioResource(grokPassthrough, { inputType: StreamType.Raw }));
    player.on('error', err => console.error('❌ Player error:', err.message));
    player.on(AudioPlayerStatus.Idle, () => {
        if (isIdleBusy || !grokPassthrough || !connection) return;
        isIdleBusy = true;
        try { player.play(createAudioResource(grokPassthrough, { inputType: StreamType.Raw })); } catch (e) { console.error('❌ reattach:', e.message); }
        setImmediate(() => { isIdleBusy = false; });
    });
}

// ─── User voice → DiscordMic → Grok browser mic ──────────────────────────────
function setupVoiceInput(receiver) {
    console.log(`🎧 استقبال صوت المستخدم: ${ALLOWED_USER_ID}`);
    function listenToUser() {
        if (!connection || !sessionUserId) return;
        const audioStream = receiver.subscribe(ALLOWED_USER_ID, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 600 }
        });
        let hasData = false;
        const pcmChunks = [];
        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        opusDecoder.on('data', chunk => pcmChunks.push(chunk));
        audioStream.on('data', () => {
            if (!hasData) {
                hasData = true;
                if (silenceTimeout) { clearTimeout(silenceTimeout); silenceTimeout = null; }
                console.log(`\n🎤 [SPEAKING] المستخدم يتكلم...`);
                updateVoiceStatus(true);
            }
        });
        if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
        ffmpegIn = spawn('ffmpeg', [
            '-loglevel', 'warning',
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
            '-f', 'pulse', 'DiscordMic'
        ]);
        ffmpegIn.stderr.on('data', d => { const m = d.toString().trim(); if (m && !m.includes('Guessed')) console.error('[FFmpeg-IN]', m); });
        ffmpegIn.on('error', err => console.error('❌ FFmpeg-IN:', err.message));
        audioStream.pipe(opusDecoder).pipe(ffmpegIn.stdin);
        audioStream.on('end', () => {
            if (hasData) {
                const sz = Buffer.concat(pcmChunks).length;
                console.log(`🎤 [STOPPED] ${(sz/1024).toFixed(1)} KB`);
                silenceTimeout = setTimeout(() => updateVoiceStatus(false), 800);
            }
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
            setTimeout(() => listenToUser(), 100);
        });
        audioStream.on('error', () => { if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; } setTimeout(() => listenToUser(), 500); });
    }
    listenToUser();
}

// ─── Grant mic to Grok and click voice button ────────────────────────────────
async function activateGrokVoiceMode() {
    if (!page) return;
    console.log('🎙️ تفعيل وضع الصوت في Grok...');
    try {
        // Grant microphone permission
        await page.context().grantPermissions(['microphone'], { origin: 'https://grok.com' });
        console.log('✅ تم منح صلاحية الميكروفون لـ Grok');

        // Dismiss Connectors popup
        try {
            await page.click('text=Dismiss', { timeout: 2000 });
            console.log('✅ تم إغلاق نافذة Connectors');
        } catch { /* no popup */ }

        await page.waitForTimeout(500);

        // Try to click the waveform/voice button (last icon in Grok input bar)
        const clicked = await page.evaluate(() => {
            // Look for buttons near the chat input
            const buttons = Array.from(document.querySelectorAll('button'));
            // The voice button usually has an SVG with wavy lines (waveform) or mic icon
            const voiceBtn = buttons.find(b => {
                const svg = b.querySelector('svg');
                if (!svg) return false;
                const label = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
                return label.includes('voice') || label.includes('mic') || label.includes('audio') || label.includes('speak');
            });
            if (voiceBtn) { voiceBtn.click(); return true; }

            // Fallback: last button in input area
            const inputArea = document.querySelector('form, [role="search"], .relative.flex');
            if (inputArea) {
                const btns = inputArea.querySelectorAll('button');
                if (btns.length > 0) { btns[btns.length - 1].click(); return 'last'; }
            }
            return false;
        });

        console.log(`🎙️ نتيجة النقر على زر الصوت: ${clicked}`);

    } catch (err) {
        console.error('❌ activateGrokVoiceMode:', err.message);
    }
}

client.on('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    console.log(`🔒 يقبل فقط من: ${ALLOWED_USER_ID}`);
    try {
        await client.application.commands.set(commands);
        console.log('✅ تم تسجيل الأوامر!');
    } catch (err) { console.error('❌ خطأ في تسجيل الأوامر:', err); }
});

// ─── Text message → send to Grok (NOT espeak) ────────────────────────────────
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.author.id !== ALLOWED_USER_ID) {
        console.log(`⛔ [IGNORED] ${message.author.tag} (${message.author.id})`);
        return;
    }
    if (!page) return;
    const text = message.content.trim();
    if (!text || text.startsWith('/')) return;
    console.log(`💬 [TEXT→GROK] "${text}"`);
    try {
        await message.react('⏳');
        await sendTextToGrok(text);
        await message.reactions.cache.get('⏳')?.remove().catch(() => {});
        await message.react('✅');
    } catch (err) {
        console.error('❌ خطأ:', err.message);
        message.react('❌').catch(() => {});
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== ALLOWED_USER_ID) {
        console.log(`⛔ [CMD BLOCKED] ${interaction.user.tag} → /${interaction.commandName}`);
        return interaction.reply({ content: '❌ ليس لديك صلاحية.', ephemeral: true });
    }

    if (interaction.commandName === 'start') {
        const voiceChannel = interaction.member?.voice.channel;
        if (!voiceChannel) return interaction.reply({ content: '❌ انضم لقناة صوتية أولاً!', ephemeral: true });
        if (browser)       return interaction.reply({ content: '⚠️ جلسة تعمل بالفعل!', ephemeral: true });

        await interaction.reply('🔄 جاري التهيئة...');
        sessionUserId = ALLOWED_USER_ID;
        statusChannel = interaction.channel;
        statusMessage = null;
        console.log(`🚀 بدء الجلسة: ${ALLOWED_USER_ID}`);

        try {
            initPlayer();

            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false, selfMute: false
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
                    // DO NOT add --use-fake-device-for-media-stream (kills PulseAudio)
                ]
            });

            // ✅ Grant mic permission at context level — fixes "Microphone access denied"
            const context = await browser.newContext({
                permissions: ['microphone'],
            });
            await context.grantPermissions(['microphone'], { origin: 'https://grok.com' });

            const convertCookies = (raw) => raw.map(c => ({
                name: c.name, value: c.value, domain: c.domain,
                path: c.path || '/',
                expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
                httpOnly: c.httpOnly || false, secure: c.secure || false,
                sameSite: (() => {
                    const s = (c.sameSite || '').toLowerCase();
                    if (s === 'strict') return 'Strict';
                    if (s === 'none' || s === 'no_restriction') return 'None';
                    return 'Lax';
                })()
            }));

            if (process.env.GROK_COOKIES) {
                try { await context.addCookies(convertCookies(JSON.parse(process.env.GROK_COOKIES))); console.log('✅ الكوكيز محملة من Railway.'); }
                catch (e) { console.error('❌ GROK_COOKIES:', e.message); interaction.channel.send('⚠️ خطأ في GROK_COOKIES!'); }
            } else if (fs.existsSync('./cookies.json')) {
                await context.addCookies(convertCookies(JSON.parse(fs.readFileSync('./cookies.json', 'utf8'))));
                console.log('✅ الكوكيز محملة من الملف.');
            } else {
                interaction.channel.send('⚠️ لم يتم العثور على كوكيز.');
            }

            page = await context.newPage();
            await page.goto('https://grok.com', { waitUntil: 'networkidle' });
            console.log('✅ Grok محمّل.');

            await activateGrokVoiceMode();

            let voiceReadyTimer = null;
            const onReady = (forced = false) => {
                if (voiceInputReady) return;
                voiceInputReady = true;
                if (voiceReadyTimer) { clearTimeout(voiceReadyTimer); voiceReadyTimer = null; }
                if (forced) console.warn('⚠️ تهيئة إجبارية');
                else        console.log('✅ الاتصال الصوتي جاهز!');
                setupVoiceInput(connection.receiver);
                setTimeout(() => startGrokAudio(), 2000);
            };

            connection.on(VoiceConnectionStatus.Ready, onReady);
            if (connection.state.status === VoiceConnectionStatus.Ready) onReady();
            else voiceReadyTimer = setTimeout(() => { if (!voiceInputReady && connection) onReady(true); }, 5000);

            connection.on(VoiceConnectionStatus.Disconnected, () => console.warn('⚠️ انقطع الاتصال الصوتي'));

            await interaction.editReply(
                '✅ **الجلسة تعمل!**\n' +
                `🔒 للمستخدم <@${ALLOWED_USER_ID}> فقط\n` +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك في القناة → Grok\n' +
                '💬 اكتب هنا → يُرسل لـ Grok مباشرة (Grok يرد بصوته)\n' +
                '🖥️ شاهد الشاشة عبر noVNC'
            );
            await updateVoiceStatus(false);

        } catch (error) {
            console.error('❌ فشل التشغيل:', error);
            await interaction.editReply('❌ فشل: ' + error.message);
            cleanupAll();
        }
    }

    if (interaction.commandName === 'stop') {
        if (!browser) return interaction.reply({ content: '⚠️ لا توجد جلسة نشطة.', ephemeral: true });
        await interaction.reply('🛑 جاري الإيقاف...');
        cleanupAll();
        await interaction.editReply('✅ تم إيقاف كل شيء بنجاح.');
    }
});

function cleanupAll() {
    if (silenceTimeout)  { clearTimeout(silenceTimeout);  silenceTimeout  = null; }
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    voiceInputReady = false;
    isSendingToGrok = false;
    if (ffmpegOut)       { ffmpegOut.stdout.unpipe(); ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }
    if (ffmpegIn)        { ffmpegIn.kill('SIGKILL');  ffmpegIn  = null; }
    if (grokPassthrough) { grokPassthrough.destroy(); grokPassthrough = null; }
    if (browser)         { browser.close().catch(() => {}); browser = null; page = null; }
    if (connection)      { connection.destroy(); connection = null; }
    if (player)          { player.stop(); player = null; }
    isIdleBusy = false; sessionUserId = null; statusMessage = null; statusChannel = null;
    console.log('🧹 تم تنظيف جميع الموارد');
}

client.login(process.env.DISCORD_TOKEN);
