const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    EndBehaviorType,
    AudioPlayerStatus,
    entersState,
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
let cdpSession      = null;
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
        // ✅ If in voice mode, exit it first so textarea appears
        const inVoiceMode = await page.evaluate(() => {
            const ta = document.querySelector('textarea');
            return !ta || ta.offsetParent === null;
        });
        if (inVoiceMode) {
            console.log('🔄 الخروج من وضع الصوت مؤقتاً لإرسال النص...');
            // Press Escape or click stop voice button
            await page.keyboard.press('Escape');
            await page.waitForTimeout(800);
            // Also try clicking any "exit voice" or "stop" button
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                for (const btn of btns) {
                    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (label.includes('exit voice') || label.includes('stop voice') || label.includes('cancel')) {
                        btn.click(); return;
                    }
                }
            });
            await page.waitForTimeout(800);
        }

        const inputSelectors = [
            'textarea[placeholder]',
            'div[contenteditable="true"]',
            '[data-testid="chat-input"]',
            'textarea'
        ];
        let inputEl = null;
        for (const sel of inputSelectors) {
            try {
                inputEl = await page.waitForSelector(sel, { timeout: 3000, state: 'visible' });
                if (inputEl) { console.log(`✅ وجد المربع: ${sel}`); break; }
            } catch { /* try next */ }
        }
        if (!inputEl) {
            console.error('❌ لم يتم العثور على مربع الإدخال');
            isSendingToGrok = false;
            return;
        }
        await inputEl.click();
        await page.keyboard.type(text, { delay: 30 });
        await page.keyboard.press('Enter');
        console.log('✅ [GROK] تم الإرسال — Grok سيرد بصوته');

        // ✅ Re-enter voice mode after sending text
        await page.waitForTimeout(1500);
        console.log('🔄 العودة لوضع الصوت...');
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('O');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
        console.log('✅ تم إعادة تفعيل وضع الصوت');

    } catch (err) {
        console.error('❌ sendTextToGrok:', err.message);
    } finally {
        isSendingToGrok = false;
    }
}

// ─── Capture Grok audio → Discord ────────────────────────────────────────────
function startGrokAudio() {
    if (ffmpegOut) { ffmpegOut.stdout.unpipe(); ffmpegOut.kill('SIGKILL'); ffmpegOut = null; }
    console.log('🔊 FFmpeg: DiscordSink.monitor → Discord');
    ffmpegOut = spawn('ffmpeg', [
        '-loglevel', 'warning',
        '-f', 'pulse', '-i', 'DiscordSink.monitor',
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-af', 'aresample=async=1000,aresample=48000',  // ✅ force 48000Hz output
        '-ac', '2', '-ar', '48000',
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'
    ]);
    ffmpegOut.stdout.pipe(grokPassthrough, { end: false });
    ffmpegOut.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('Guessed Channel')) console.error('[FFmpeg-OUT]', msg);
    });
    ffmpegOut.on('error', err => {
        console.error('❌ FFmpeg-OUT:', err.message);
        setTimeout(() => { if (connection) startGrokAudio(); }, 2000);
    });
    ffmpegOut.on('exit', (code, sig) => {
        if (sig !== 'SIGKILL') {
            console.warn(`⚠️ FFmpeg-OUT exit ${code}, restarting`);
            setTimeout(() => { if (connection) startGrokAudio(); }, 1000);
        }
    });
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
        try { player.play(createAudioResource(grokPassthrough, { inputType: StreamType.Raw })); }
        catch (e) { console.error('❌ reattach:', e.message); }
        setImmediate(() => { isIdleBusy = false; });
    });
}

// ─── User voice → DiscordMic → Grok browser ──────────────────────────────────
function setupVoiceInput(receiver) {
    console.log(`🎧 استقبال صوت: ${ALLOWED_USER_ID}`);
    function listenToUser() {
        if (!connection || !sessionUserId) return;

        const audioStream = receiver.subscribe(ALLOWED_USER_ID, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 600 }
        });
        console.log(`🔔 [VOICE] مشترك في صوت المستخدم — في انتظار الصوت...`);

        let hasData = false;

        // ✅ Spawn FFmpeg first so it's ready to receive piped audio immediately
        if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
        ffmpegIn = spawn('ffmpeg', [
            '-loglevel', 'warning',
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
            '-af', 'aresample=async=1000,aresample=48000',
            '-f', 'pulse',
            'DiscordMic',   // ✅ target the sink directly (not -device flag which is wrong)
        ]);
        ffmpegIn.stderr.on('data', d => {
            const m = d.toString().trim();
            if (m && !m.includes('Guessed') && !m.includes('monoton')) console.error('[FFmpeg-IN]', m);
        });
        ffmpegIn.on('error', err => console.error('❌ FFmpeg-IN spawn:', err.message));
        ffmpegIn.stdin.on('error', () => {}); // prevent EPIPE crash

        // ✅ Decode Opus → PCM → FFmpeg stdin
        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        opusDecoder.on('error', err => console.error('❌ OpusDecoder:', err.message));

        audioStream.on('data', () => {
            if (!hasData) {
                hasData = true;
                if (silenceTimeout) { clearTimeout(silenceTimeout); silenceTimeout = null; }
                console.log(`\n🎤 [SPEAKING] المستخدم يتكلم...`);
                updateVoiceStatus(true);
            }
        });

        audioStream.pipe(opusDecoder).pipe(ffmpegIn.stdin, { end: false });

        audioStream.on('end', () => {
            if (hasData) {
                console.log(`🎤 [STOPPED] انتهى الصوت`);
                silenceTimeout = setTimeout(() => updateVoiceStatus(false), 800);
            }
            opusDecoder.unpipe(ffmpegIn.stdin);
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
            setTimeout(() => listenToUser(), 100);
        });

        audioStream.on('error', (err) => {
            console.error('❌ audioStream error:', err.message);
            if (ffmpegIn) { ffmpegIn.kill('SIGKILL'); ffmpegIn = null; }
            setTimeout(() => listenToUser(), 500);
        });
    }
    listenToUser();
}

// ─── GRANT MIC VIA CDP + CLICK VOICE BUTTON ──────────────────────────────────
async function activateGrokVoiceMode() {
    if (!page) return;
    console.log('🎙️ تفعيل وضع الصوت في Grok...');

    // Handle any JS dialogs that might block clicks
    page.on('dialog', async dialog => {
        console.log(`📢 Dialog: ${dialog.type()} — ${dialog.message()}`);
        await dialog.dismiss();
    });

    try {
        // ── Step 1: Dismiss any popups / overlays ─────────────────────────
        const dismissSelectors = [
            'button:has-text("Dismiss")',
            'button:has-text("Got it")',
            'button:has-text("Close")',
            '[aria-label="Close"]',
            '[aria-label="Dismiss"]',
        ];
        for (const sel of dismissSelectors) {
            try {
                await page.click(sel, { timeout: 1500 });
                console.log(`✅ أُغلق: ${sel}`);
                await page.waitForTimeout(400);
            } catch { /* not present */ }
        }

        // ── Step 2: Wait for the input area to be ready ───────────────────
        try {
            await page.waitForSelector('form, textarea, [role="textbox"]', { timeout: 10000, state: 'visible' });
            console.log('✅ منطقة الإدخال جاهزة');
        } catch {
            console.warn('⚠️ لم تظهر منطقة الإدخال بعد 10 ثوانٍ');
        }
        await page.waitForTimeout(800);

        // ── Step 3: Try specific Grok voice button selectors first ────────
        const voiceButtonSelectors = [
            // Grok's actual voice mode button (by aria-label)
            'button[aria-label*="voice" i]',
            'button[aria-label*="Voice" i]',
            'button[aria-label*="mic" i]',
            'button[aria-label*="Mic" i]',
            'button[aria-label*="audio" i]',
            'button[aria-label*="speak" i]',
            // data-testid patterns Grok might use
            '[data-testid*="voice"]',
            '[data-testid*="mic"]',
            // Title attribute fallbacks
            'button[title*="voice" i]',
            'button[title*="mic" i]',
        ];

        let clicked = false;
        for (const sel of voiceButtonSelectors) {
            try {
                const btn = await page.waitForSelector(sel, { timeout: 2000, state: 'visible' });
                if (btn) {
                    await btn.scrollIntoViewIfNeeded();
                    await btn.click({ force: true });
                    console.log(`✅ [Strategy-1] نقر على: ${sel}`);
                    clicked = true;
                    break;
                }
            } catch { /* try next */ }
        }

        // ── Step 4: Fallback — scan all buttons by text/SVG heuristics ────
        if (!clicked) {
            const result = await page.evaluate(() => {
                const allBtns = Array.from(document.querySelectorAll('button'));

                // 4a: Match by any voice/mic keyword in accessible text
                for (const btn of allBtns) {
                    const text = [
                        btn.getAttribute('aria-label'),
                        btn.getAttribute('title'),
                        btn.textContent,
                    ].filter(Boolean).join(' ').toLowerCase();
                    if (/voice|mic|audio|speak|waveform|sound/.test(text)) {
                        btn.click();
                        return `text-match: "${text.substring(0, 60)}"`;
                    }
                }

                // 4b: Grok's voice button sits in the form's bottom-right area
                //     It's typically a round button with a microphone/waveform SVG
                const form = document.querySelector('form');
                if (form) {
                    const btns = Array.from(form.querySelectorAll('button'));
                    // Prefer buttons with an SVG child and at least 2 paths (waveform)
                    for (const btn of btns) {
                        const paths = btn.querySelectorAll('svg path, svg rect, svg circle');
                        if (paths.length >= 2) {
                            const rect = btn.getBoundingClientRect();
                            // Must be in the lower portion of the viewport
                            if (rect.top > window.innerHeight * 0.55 && rect.width > 0) {
                                btn.click();
                                return `svg-form-btn at y=${Math.round(rect.top)} paths=${paths.length}`;
                            }
                        }
                    }
                    // Last resort: last visible button in form
                    const visibleBtns = btns.filter(b => {
                        const r = b.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    });
                    if (visibleBtns.length > 0) {
                        visibleBtns[visibleBtns.length - 1].click();
                        return `last-form-btn (total ${visibleBtns.length})`;
                    }
                }

                // 4c: Any round button in the bottom half of the screen
                for (const btn of allBtns) {
                    const rect = btn.getBoundingClientRect();
                    const style = window.getComputedStyle(btn);
                    const radius = parseInt(style.borderRadius) || 0;
                    if (radius >= 20 && rect.top > window.innerHeight * 0.6 && rect.width > 0) {
                        btn.click();
                        return `round-btn at y=${Math.round(rect.top)} r=${radius}`;
                    }
                }

                return null;
            });

            if (result) {
                console.log(`✅ [Strategy-2] نقر: ${result}`);
                clicked = true;
            } else {
                console.warn('⚠️ [Strategy-2] لم يُعثر على زر الصوت');
            }
        }

        await page.waitForTimeout(1200);

        // ── Step 5: Verify mic permission dialog and accept it ─────────────
        // Chrome may show a permission bubble after clicking voice
        try {
            // Re-grant via CDP in case the origin changed after navigation
            if (cdpSession) {
                await cdpSession.send('Browser.grantPermissions', {
                    permissions: ['audioCapture', 'videoCapture'],
                    origin: 'https://grok.com'
                });
                console.log('✅ CDP mic re-granted after voice button click');
            }
        } catch (e) {
            console.warn('⚠️ CDP re-grant:', e.message);
        }

        // ── Step 6: Confirm voice mode is active ──────────────────────────
        await page.waitForTimeout(800);
        const inVoiceMode = await page.evaluate(() => {
            // Voice mode: textarea hidden OR a mic/waveform animation visible
            const ta = document.querySelector('textarea');
            const textareaHidden = !ta || ta.offsetParent === null;

            // Also check for any animated voice UI element
            const voiceUI = document.querySelector(
                '[class*="voice"], [class*="mic"], [class*="waveform"], [class*="listening"]'
            );
            return textareaHidden || !!voiceUI;
        });

        if (inVoiceMode) {
            console.log('✅ وضع الصوت مُفعَّل — الميكروفون يستمع 🎤');
            console.log('✅ activateGrokVoiceMode مكتمل');
            return true;   // ← caller must NOT send Ctrl+Shift+O (would toggle OFF)
        } else {
            console.warn('⚠️ وضع الصوت غير مُفعَّل بعد — يحتاج Ctrl+Shift+O');
            console.log('✅ activateGrokVoiceMode مكتمل');
            return false;  // ← caller should try Ctrl+Shift+O
        }

    } catch (err) {
        console.error('❌ activateGrokVoiceMode:', err.message);
        return false;
    }
}

// ─── Bot ready ────────────────────────────────────────────────────────────────
client.on('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    console.log(`🔒 يقبل فقط من: ${ALLOWED_USER_ID}`);
    try {
        await client.application.commands.set(commands);
        console.log('✅ تم تسجيل الأوامر!');
    } catch (err) { console.error('❌ خطأ في تسجيل الأوامر:', err); }
});

// ─── Text → Grok ──────────────────────────────────────────────────────────────
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

// ─── Slash commands ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== ALLOWED_USER_ID) {
        console.log(`⛔ [BLOCKED] ${interaction.user.tag} → /${interaction.commandName}`);
        return interaction.reply({ content: '❌ ليس لديك صلاحية.', ephemeral: true });
    }

    // ━━━ /start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

            // ✅ Launch WITHOUT --use-fake-ui-for-media-stream so real PulseAudio mic works
            // ✅ Use --use-fake-device-for-media-stream to keep Chrome from complaining about no hardware
            browser = await chromium.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--autoplay-policy=no-user-gesture-required',
                    // ✅ Suppresses the mic/camera PERMISSION DIALOG without faking the device
                    //    (different from --use-fake-device-for-media-stream which silences audio)
                    '--use-fake-ui-for-media-stream',
                    '--allow-file-access-from-files',
                    '--disable-web-security',
                    '--disable-features=WebRtcHideLocalIpsWithMdns',
                    // ✅ Force Chrome to use PulseAudio for both input and output
                    '--enable-features=PulseAudio',
                ]
            });

            // ✅ Context with mic pre-granted at the browser context level
            const context = await browser.newContext({
                permissions: ['microphone', 'camera'],
            });

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
                try {
                    await context.addCookies(convertCookies(JSON.parse(process.env.GROK_COOKIES)));
                    console.log('✅ الكوكيز محملة من Railway.');
                } catch (e) {
                    console.error('❌ GROK_COOKIES:', e.message);
                    interaction.channel.send('⚠️ خطأ في GROK_COOKIES!');
                }
            } else if (fs.existsSync('./cookies.json')) {
                await context.addCookies(convertCookies(JSON.parse(fs.readFileSync('./cookies.json', 'utf8'))));
                console.log('✅ الكوكيز من الملف.');
            } else {
                interaction.channel.send('⚠️ لم يتم العثور على كوكيز.');
            }

            page = await context.newPage();

            // ✅ Inject permission + getUserMedia overrides BEFORE page loads
            await page.addInitScript(() => {
                // 1. Make permissions.query always return 'granted' for mic/camera
                const origQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = (p) => {
                    if (p && (p.name === 'microphone' || p.name === 'camera')) {
                        return Promise.resolve({ state: 'granted', onchange: null });
                    }
                    return origQuery(p);
                };

                // 2. Override getUserMedia to use PulseAudio VirtualMic (disable processing that interferes)
                const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                navigator.mediaDevices.getUserMedia = (constraints) => {
                    if (constraints && constraints.audio) {
                        constraints.audio = {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                            // Don't restrict to a specific deviceId — let PulseAudio default source work
                        };
                    }
                    return origGUM(constraints);
                };

                console.log('[BOT] Permission + getUserMedia overrides injected');
            });

            // ✅ Grant mic via CDP BEFORE navigating — this is the critical order fix
            try {
                cdpSession = await context.newCDPSession(page);
                await cdpSession.send('Browser.grantPermissions', {
                    permissions: ['audioCapture', 'videoCapture'],
                    origin: 'https://grok.com'
                });
                console.log('✅ CDP: audioCapture + videoCapture granted BEFORE navigation');
            } catch (cdpErr) {
                console.warn('⚠️ CDP grant failed (non-fatal):', cdpErr.message);
            }

            // ✅ Use domcontentloaded — grok.com never reaches networkidle (keeps WS alive)
            try {
                await page.goto('https://grok.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (navErr) {
                // If even domcontentloaded times out, try load event
                console.warn('⚠️ domcontentloaded timeout, retrying with load...');
                await page.goto('https://grok.com', { waitUntil: 'load', timeout: 60000 });
            }
            // Wait for page to settle (React hydration, lazy loads)
            await page.waitForTimeout(3000);
            console.log('✅ Grok محمّل.');

            const voiceActivated = await activateGrokVoiceMode();

            // ✅ Only try Ctrl+Shift+O if the button click failed — NOT if it succeeded
            //    (Ctrl+Shift+O is a toggle — sending it when already active turns voice OFF)
            if (!voiceActivated) {
                console.warn('⚠️ زر الصوت فشل — تجربة Ctrl+Shift+O');
                await page.keyboard.down('Control');
                await page.keyboard.down('Shift');
                await page.keyboard.press('O');
                await page.keyboard.up('Shift');
                await page.keyboard.up('Control');
                await page.waitForTimeout(2000);
                console.log('✅ تم إرسال Ctrl+Shift+O');
            } else {
                console.log('✅ وضع الصوت مفعّل بنجاح — لا حاجة لـ Ctrl+Shift+O');
            }

            // ─── Voice connection ─────────────────────────────────────────
            // ✅ Proper Ready wait — handles case where Ready already fired before we get here
            await new Promise((resolve) => {
                const status = connection.state.status;
                console.log(`🔗 Voice connection state: ${status}`);

                if (status === VoiceConnectionStatus.Ready) {
                    console.log('✅ الاتصال الصوتي كان جاهزاً بالفعل');
                    return resolve();
                }

                // If destroyed/disconnected already, just proceed with forced init
                if (status === VoiceConnectionStatus.Destroyed ||
                    status === VoiceConnectionStatus.Disconnected) {
                    console.warn(`⚠️ الاتصال في حالة ${status} — متابعة بدون انتظار`);
                    return resolve();
                }

                const timer = setTimeout(() => {
                    console.warn(`⚠️ تهيئة إجبارية — الحالة: ${connection.state.status}`);
                    resolve();
                }, 10000);

                connection.once(VoiceConnectionStatus.Ready, () => {
                    clearTimeout(timer);
                    console.log('✅ الاتصال الصوتي جاهز!');
                    resolve();
                });

                // Also resolve if it disconnects (avoid hanging)
                connection.once(VoiceConnectionStatus.Disconnected, () => {
                    clearTimeout(timer);
                    console.warn('⚠️ انقطع الاتصال أثناء الانتظار');
                    resolve();
                });
            });

            if (!voiceInputReady && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                voiceInputReady = true;
                setupVoiceInput(connection.receiver);
                setTimeout(() => startGrokAudio(), 2000);
            }

            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                console.warn('⚠️ انقطع الاتصال — محاولة إعادة الاتصال...');
                voiceInputReady = false;
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                    ]);
                    // Reconnected — wait for Ready again
                    await entersState(connection, VoiceConnectionStatus.Ready, 10000);
                    console.log('✅ أُعيد الاتصال الصوتي!');
                    if (!voiceInputReady) {
                        voiceInputReady = true;
                        setupVoiceInput(connection.receiver);
                    }
                } catch {
                    console.error('❌ فشل إعادة الاتصال — تنظيف...');
                    cleanupAll();
                }
            });

            await interaction.editReply(
                '✅ **الجلسة تعمل!**\n' +
                `🔒 للمستخدم <@${ALLOWED_USER_ID}> فقط\n` +
                '🔊 صوت Grok → Discord\n' +
                '🎤 صوتك → Grok\n' +
                '💬 اكتب هنا → يُرسل لـ Grok (يرد بصوته)\n' +
                '🖥️ noVNC لمشاهدة الشاشة'
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

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function cleanupAll() {
    if (silenceTimeout)  { clearTimeout(silenceTimeout);  silenceTimeout  = null; }
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    voiceInputReady = false;
    isSendingToGrok = false;
    if (cdpSession)      { cdpSession.detach().catch(() => {}); cdpSession = null; }
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
