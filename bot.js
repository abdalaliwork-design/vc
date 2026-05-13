process.env.DISCORDJS_NO_LAZY_LOAD = 'true';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROK_URL = process.env.GROK_URL || 'https://grok.com';
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || null;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

let browser = null;
let context = null;
let page = null;
let cdpSession = null;

let ffmpegOut = null;
let ffmpegIn = null;

let connection = null;
let player = null;
let grokPassthrough = null;

let silenceInterval = null;
let inputKeepAliveInterval = null;

let isIdleBusy = false;
let voiceInputReady = false;
let statusMessage = null;
let statusChannel = null;
let silenceTimeout = null;
let isSendingToGrok = false;
let currentDecoder = null;
let activeAudioStream = null;
let isUserSpeaking = false;
let speakingEndTimer = null;
let currentGuild = null;

const SILENCE_FRAME = Buffer.alloc(960 * 2 * 2);
const speakerSessions = new Map();

const commands = [
  { name: 'start', description: 'يبدأ جلسة Grok ويربط الصوت' },
  { name: 'stop', description: 'يوقف الجلسة ويحرر الموارد' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeKill(proc, signal = 'SIGKILL') {
  if (!proc) return;
  try {
    proc.kill(signal);
  } catch {}
}

function getSpeakerLabel(userId) {
  const member = currentGuild?.members?.cache?.get(userId);
  if (member) return member.displayName || member.user?.username || userId;
  const user = client.users.cache.get(userId);
  return user?.username || userId;
}

async function postVoiceChat(text) {
  if (!statusChannel) return;
  try {
    await statusChannel.send(text);
  } catch (e) {
    console.error('❌ postVoiceChat:', e.message);
  }
}

async function updateVoiceStatus(speaking) {
  if (!statusChannel) return;
  const content = speaking
    ? '🟢 **صوت مسموع** — البوت يسمع الآن 🎤'
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

function ensureInputPipeline() {
  if (ffmpegIn) return ffmpegIn;

  console.log('🎤 Starting persistent FFmpeg input pipeline → DiscordMic');
  ffmpegIn = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-fflags', '+genpts',
    '-thread_queue_size', '4096',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-i', 'pipe:0',
    '-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'pulse',
    'DiscordMic',
  ], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  ffmpegIn.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('Guessed Channel Layout')) {
      console.error('[FFmpeg-IN]', msg);
    }
  });

  ffmpegIn.on('error', (err) => {
    console.error('❌ FFmpeg-IN:', err.message);
  });

  ffmpegIn.on('exit', (code, sig) => {
    console.warn(`⚠️ FFmpeg-IN exit code=${code} sig=${sig}`);
    ffmpegIn = null;
    if (connection && !connection.destroyed) {
      setTimeout(() => ensureInputPipeline(), 1500);
    }
  });

  ffmpegIn.stdin.on('error', () => {});
  return ffmpegIn;
}

function ensureOutputPipeline() {
  if (ffmpegOut) return ffmpegOut;

  console.log('🔊 Starting persistent FFmpeg output pipeline DiscordSink.monitor → Discord');
  ffmpegOut = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-f', 'pulse',
    '-i', 'DiscordSink.monitor',
    '-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ffmpegOut.stdout.pipe(grokPassthrough, { end: false });

  ffmpegOut.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('Guessed Channel Layout')) {
      console.error('[FFmpeg-OUT]', msg);
    }
  });

  ffmpegOut.on('error', (err) => {
    console.error('❌ FFmpeg-OUT:', err.message);
  });

  ffmpegOut.on('exit', (code, sig) => {
    console.warn(`⚠️ FFmpeg-OUT exit code=${code} sig=${sig}`);
    ffmpegOut = null;
    if (connection && !connection.destroyed) {
      setTimeout(() => ensureOutputPipeline(), 1500);
    }
  });

  return ffmpegOut;
}

function initPlayer() {
  grokPassthrough = new PassThrough({ highWaterMark: 1024 * 1024 });

  silenceInterval = setInterval(() => {
    if (grokPassthrough && !grokPassthrough.destroyed) {
      grokPassthrough.write(SILENCE_FRAME);
    }
  }, 20);

  player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  player.play(createAudioResource(grokPassthrough, { inputType: StreamType.Raw }));

  player.on('error', (err) => console.error('❌ Player error:', err.message));

  player.on(AudioPlayerStatus.Idle, () => {
    if (isIdleBusy || !grokPassthrough || !connection) return;
    isIdleBusy = true;
    try {
      player.play(createAudioResource(grokPassthrough, { inputType: StreamType.Raw }));
    } catch (e) {
      console.error('❌ reattach:', e.message);
    }
    setImmediate(() => {
      isIdleBusy = false;
    });
  });
}

async function sendTextToGrok(text) {
  if (!page || isSendingToGrok) return;
  isSendingToGrok = true;
  console.log(`📨 [GROK] إرسال: "${text}"`);

  try {
    const inVoiceMode = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      return !ta || ta.offsetParent === null;
    });

    if (inVoiceMode) {
      console.log('🔄 الخروج من وضع الصوت مؤقتاً لإرسال النص...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        for (const btn of btns) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('exit voice') || label.includes('stop voice') || label.includes('cancel')) {
            btn.click();
            return;
          }
        }
      });
      await page.waitForTimeout(800);
    }

    const inputSelectors = [
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      '[data-testid="chat-input"]',
      'textarea',
    ];

    let inputEl = null;
    for (const sel of inputSelectors) {
      try {
        inputEl = await page.waitForSelector(sel, { timeout: 3000, state: 'visible' });
        if (inputEl) {
          console.log(`✅ وجد المربع: ${sel}`);
          break;
        }
      } catch {}
    }

    if (!inputEl) {
      console.error('❌ لم يتم العثور على مربع الإدخال');
      return;
    }

    await inputEl.click();
    await page.keyboard.type(text, { delay: 30 });
    await page.keyboard.press('Enter');
    console.log('✅ [GROK] تم الإرسال — Grok سيرد بصوته');

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

function cleanupSpeakerSession(userId) {
  const session = speakerSessions.get(userId);
  if (!session) return;

  try {
    session.stream?.removeAllListeners();
    session.stream?.destroy();
  } catch {}

  try {
    session.decoder?.removeAllListeners();
    session.decoder?.destroy();
  } catch {}

  speakerSessions.delete(userId);

  if (speakerSessions.size === 0) {
    isUserSpeaking = false;
    currentDecoder = null;
    activeAudioStream = null;
  }
}

function startSpeakerSession(receiver, userId) {
  if (speakerSessions.has(userId)) return;
  ensureInputPipeline();

  isUserSpeaking = true;
  currentDecoder = true;
  const label = getSpeakerLabel(userId);

  postVoiceChat(`🎤 **${label}** user talk`);
  updateVoiceStatus(true);

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  decoder.on('error', (err) => {
    console.error(`❌ OpusDecoder(${userId}):`, err.message);
  });

  const stream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
  });

  stream.on('error', async (err) => {
    console.error(`❌ audioStream(${userId}) error:`, err.message);
    cleanupSpeakerSession(userId);
    if (speakerSessions.size === 0) {
      await updateVoiceStatus(false);
    }
  });

  stream.on('end', async () => {
    cleanupSpeakerSession(userId);
    const endedLabel = getSpeakerLabel(userId);
    await postVoiceChat(`🔇 **${endedLabel}** user stopped`);
    if (speakerSessions.size === 0) {
      await updateVoiceStatus(false);
    }
  });

  decoder.on('data', (chunk) => {
    if (ffmpegIn?.stdin?.writable) {
      const ok = ffmpegIn.stdin.write(chunk);
      if (!ok) {
        stream.pause?.();
        ffmpegIn.stdin.once('drain', () => {
          stream.resume?.();
        });
      }
    }
  });

  stream.pipe(decoder);

  speakerSessions.set(userId, { stream, decoder });
  activeAudioStream = stream;
  currentDecoder = decoder;
}

function setupVoiceInput(receiver) {
  console.log('🎧 إعداد استقبال الصوت لجميع المستخدمين في القناة...');

  receiver.speaking.on('start', (userId) => {
    if (userId === client.user?.id) return;
    if (silenceTimeout) {
      clearTimeout(silenceTimeout);
      silenceTimeout = null;
    }
    if (speakerSessions.has(userId)) return;
    console.log(`🎤 [SPEAKING] user ${userId} started`);
    startSpeakerSession(receiver, userId);
  });

  receiver.speaking.on('end', (userId) => {
    if (userId === client.user?.id) return;
    console.log(`🎤 [STOPPED] user ${userId} ended`);
  });

  if (!inputKeepAliveInterval) {
    inputKeepAliveInterval = setInterval(() => {
      if (!ffmpegIn?.stdin?.writable) return;
      if (speakerSessions.size === 0) {
        ffmpegIn.stdin.write(SILENCE_FRAME);
      }
    }, 20);
  }
}

async function activateGrokVoiceMode() {
  if (!page) return false;
  console.log('🎙️ تفعيل وضع الصوت في Grok...');

  try {
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
      } catch {}
    }

    try {
      await page.waitForSelector('form, textarea, [role="textbox"], [contenteditable="true"]', {
        timeout: 10000,
        state: 'visible',
      });
      console.log('✅ منطقة الإدخال جاهزة');
    } catch {
      console.warn('⚠️ لم تظهر منطقة الإدخال بعد 10 ثوانٍ');
    }

    await page.waitForTimeout(800);

    const voiceButtonSelectors = [
      'button[aria-label*="voice" i]',
      'button[aria-label*="Voice" i]',
      'button[aria-label*="mic" i]',
      'button[aria-label*="Mic" i]',
      'button[aria-label*="audio" i]',
      'button[aria-label*="speak" i]',
      '[data-testid*="voice"]',
      '[data-testid*="mic"]',
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
      } catch {}
    }

    if (!clicked) {
      const result = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));

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

        const form = document.querySelector('form');
        if (form) {
          const btns = Array.from(form.querySelectorAll('button'));
          for (const btn of btns) {
            const paths = btn.querySelectorAll('svg path, svg rect, svg circle');
            if (paths.length >= 2) {
              const rect = btn.getBoundingClientRect();
              if (rect.top > window.innerHeight * 0.55 && rect.width > 0) {
                btn.click();
                return `svg-form-btn at y=${Math.round(rect.top)} paths=${paths.length}`;
              }
            }
          }
          const visibleBtns = btns.filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (visibleBtns.length > 0) {
            visibleBtns[visibleBtns.length - 1].click();
            return `last-form-btn (total ${visibleBtns.length})`;
          }
        }

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

    try {
      if (cdpSession) {
        await cdpSession.send('Browser.grantPermissions', {
          permissions: ['audioCapture', 'videoCapture'],
          origin: GROK_URL,
        });
        console.log('✅ CDP mic re-granted after voice button click');
      }
    } catch (e) {
      console.warn('⚠️ CDP re-grant:', e.message);
    }

    await page.waitForTimeout(800);

    const inVoiceMode = await page.evaluate(() => {
      const voiceUI = document.querySelector(
        '[class*="voice"], [class*="mic"], [class*="waveform"], [class*="listening"]'
      );
      const ta = document.querySelector('textarea');
      const textareaHidden = ta && ta.offsetParent === null;
      return !!voiceUI || textareaHidden;
    });

    if (inVoiceMode) {
      console.log('✅ وضع الصوت مُفعَّل — الميكروفون يستمع 🎤');
      return true;
    }

    console.warn('⚠️ وضع الصوت غير مُفعَّل');
    return false;
  } catch (err) {
    console.error('❌ activateGrokVoiceMode:', err.message);
    return false;
  }
}

function convertCookies(raw) {
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: (() => {
      const s = (c.sameSite || '').toLowerCase();
      if (s === 'strict') return 'Strict';
      if (s === 'none' || s === 'no_restriction') return 'None';
      return 'Lax';
    })(),
  }));
}

async function startGrokBrowser() {
  browser = await chromium.launch({
    headless: false,
    env: {
      ...process.env,
      PULSE_SINK: 'DiscordSink',
      PULSE_SOURCE: 'VirtualMic',
      PULSE_LATENCY_MSEC: process.env.PULSE_LATENCY_MSEC || '120',
      DISPLAY: ':99',
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--allow-file-access-from-files',
      '--disable-web-security',
      '--disable-features=WebRtcHideLocalIpsWithMdns,AudioServiceOutOfProcess',
      '--enable-features=PulseAudio',
    ],
  });

  context = await browser.newContext();
  await context.grantPermissions(['microphone', 'camera'], { origin: GROK_URL });

  if (process.env.GROK_COOKIES) {
    try {
      await context.addCookies(convertCookies(JSON.parse(process.env.GROK_COOKIES)));
      console.log('✅ Cookies loaded from env');
    } catch (e) {
      console.error('❌ GROK_COOKIES:', e.message);
    }
  } else if (fs.existsSync('./cookies.json')) {
    try {
      await context.addCookies(convertCookies(JSON.parse(fs.readFileSync('./cookies.json', 'utf8'))));
      console.log('✅ Cookies loaded from file');
    } catch (e) {
      console.error('❌ cookies.json:', e.message);
    }
  }

  page = await context.newPage();

  page.on('dialog', async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {}
  });

  await page.addInitScript(() => {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) => {
      if (p && (p.name === 'microphone' || p.name === 'camera')) {
        return Promise.resolve({ state: 'granted', onchange: null });
      }
      return origQuery(p);
    };

    const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints && constraints.audio) {
        constraints.audio = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
      }
      return origGUM(constraints);
    };
  });

  try {
    await page.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch {
    await page.goto(GROK_URL, { waitUntil: 'load', timeout: 60000 });
  }

  await page.waitForTimeout(2500);
  console.log('✅ Grok loaded');

  const voiceActivated = await activateGrokVoiceMode();
  if (!voiceActivated) {
    console.warn('⚠️ Voice mode not fully detected, trying Ctrl+Shift+O');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('O');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForTimeout(1500);
  }
}

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
  console.log(`🔒 Allowed user restriction: ${ALLOWED_USER_ID || 'none (everyone can speak)'}`);

  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ command registration failed:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!page) return;

  const text = message.content.trim();
  if (!text || text.startsWith('/')) return;

  if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) return;

  console.log(`💬 [TEXT→GROK] "${text}"`);

  try {
    await message.react('⏳');
    await sendTextToGrok(text);
    await message.reactions.cache.get('⏳')?.remove().catch(() => {});
    await message.react('✅');
  } catch (err) {
    console.error('❌ messageCreate:', err.message);
    message.react('❌').catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (ALLOWED_USER_ID && interaction.user.id !== ALLOWED_USER_ID) {
    return interaction.reply({
      content: '❌ ليس لديك صلاحية.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'start') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ انضم لقناة صوتية أولاً!',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (browser) {
      return interaction.reply({
        content: '⚠️ جلسة تعمل بالفعل!',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply('🔄 جاري التهيئة...');
    statusChannel = interaction.channel;
    statusMessage = null;
    currentGuild = interaction.guild;

    try {
      initPlayer();
      ensureInputPipeline();

      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      connection.on('stateChange', (oldState, newState) => {
        console.log(`🔄 Voice State: ${oldState.status} -> ${newState.status}`);
      });

      connection.on('error', (err) => {
        console.error('❌ Voice connection error:', err);
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 120000);
      console.log('✅ Voice connection READY');

      connection.subscribe(player);

      await startGrokBrowser();
      ensureOutputPipeline();

      if (!voiceInputReady && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        voiceInputReady = true;
        setupVoiceInput(connection.receiver);
      }

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.warn('⚠️ انقطع الاتصال — محاولة إعادة الاتصال...');
        voiceInputReady = false;
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
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
        `🔊 صوت Grok → Discord\n` +
        `🎤 صوت القناة → Grok\n` +
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

  if (interaction.commandName === 'stop') {
    if (!browser) {
      return interaction.reply({
        content: '⚠️ لا توجد جلسة نشطة.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.reply('🛑 جاري الإيقاف...');
    cleanupAll();
    await interaction.editReply('✅ تم إيقاف كل شيء بنجاح.');
  }
});

function cleanupAll() {
  if (speakingEndTimer) {
    clearTimeout(speakingEndTimer);
    speakingEndTimer = null;
  }

  if (silenceTimeout) {
    clearTimeout(silenceTimeout);
    silenceTimeout = null;
  }

  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }

  if (inputKeepAliveInterval) {
    clearInterval(inputKeepAliveInterval);
    inputKeepAliveInterval = null;
  }

  voiceInputReady = false;
  isSendingToGrok = false;
  isUserSpeaking = false;

  for (const userId of speakerSessions.keys()) {
    cleanupSpeakerSession(userId);
  }
  speakerSessions.clear();

  if (cdepSession) {
    try {
      cdepSession.detach().catch(() => {});
    } catch {}
    cdepSession = null;
  }

  if (ffmpegOut) {
    try {
      ffmpegOut.stdout.unpipe();
    } catch {}
    safeKill(ffmpegOut);
    ffmpegOut = null;
  }

  if (ffmpegIn) {
    try {
      if (ffmpegIn.stdin && !ffmpegIn.stdin.destroyed) {
        ffmpegIn.stdin.end();
      }
    } catch {}
    safeKill(ffmpegIn);
    ffmpegIn = null;
  }

  if (grokPassthrough) {
    try {
      grokPassthrough.destroy();
    } catch {}
    grokPassthrough = null;
  }

  if (browser) {
    browser.close().catch(() => {});
    browser = null;
    context = null;
    page = null;
  }

  if (connection) {
    try {
      connection.destroy();
    } catch {}
    connection = null;
  }

  if (player) {
    try {
      player.stop();
    } catch {}
    player = null;
  }

  isIdleBusy = false;
  statusMessage = null;
  statusChannel = null;
  currentGuild = null;

  console.log('🧹 تم تنظيف جميع الموارد');
}

process.on('SIGINT', () => {
  cleanupAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ unhandledRejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err);
});

client.login(DISCORD_TOKEN);
