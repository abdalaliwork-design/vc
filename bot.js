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

const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || '712321588342816879';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROK_URL = process.env.GROK_URL || 'https://grok.com';

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
  ],
});

let browser = null;
let context = null;
let page = null;
let ffmpegOut = null;
let ffmpegIn = null;
let connection = null;
let player = null;
let grokPassthrough = null;
let silenceInterval = null;
let inputKeepAliveInterval = null;
let isIdleBusy = false;
let voiceInputReady = false;
let sessionUserId = null;
let statusMessage = null;
let statusChannel = null;
let silenceTimeout = null;
let isSendingToGrok = false;
let currentDecoder = null;
let activeAudioStream = null;
let activeVoice = false;

const SILENCE_FRAME = Buffer.alloc(960 * 2 * 2);

const commands = [
  { name: 'start', description: 'يبدأ جلسة Grok ويربط الصوت' },
  { name: 'stop', description: 'يوقف الجلسة ويحرر الموارد' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateVoiceStatus(speaking) {
  if (!statusChannel) return;
  const content = speaking
    ? '🟢 **صوتك وصل** — البوت يسمعك الآن 🎤'
    : '🔴 **لا يوجد صوت** — تحدث في القناة الصوتية 🔇';
  try {
    if (statusMessage) await statusMessage.edit(content);
    else statusMessage = await statusChannel.send(content);
  } catch (e) {
    console.error('❌ updateVoiceStatus:', e.message);
  }
}

function safeKill(proc, signal = 'SIGKILL') {
  if (!proc) return;
  try {
    proc.kill(signal);
  } catch {}
}

function cleanupInputStream() {
  activeVoice = false;

  if (currentDecoder) {
    try {
      currentDecoder.destroy();
    } catch {}
    currentDecoder = null;
  }

  if (activeAudioStream) {
    try {
      activeAudioStream.removeAllListeners();
      activeAudioStream.destroy();
    } catch {}
    activeAudioStream = null;
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
  console.log(`📨 [GROK] Sending: "${text}"`);

  try {
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
        if (inputEl) break;
      } catch {}
    }

    if (!inputEl) {
      console.error('❌ Could not find Grok input box');
      return;
    }

    await inputEl.click();
    await page.keyboard.type(text, { delay: 25 });
    await page.keyboard.press('Enter');

    console.log('✅ Text sent to Grok');

    await sleep(1200);
    await activateGrokVoiceMode();
  } catch (err) {
    console.error('❌ sendTextToGrok:', err.message);
  } finally {
    isSendingToGrok = false;
  }
}

function startUserAudioCapture(receiver) {
  if (activeAudioStream || currentDecoder) return;

  ensureInputPipeline();
  activeVoice = true;
  updateVoiceStatus(true);

  currentDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  currentDecoder.on('error', (err) => {
    console.error('❌ OpusDecoder:', err.message);
  });

  activeAudioStream = receiver.subscribe(ALLOWED_USER_ID, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
  });

  activeAudioStream.on('error', (err) => {
    console.error('❌ audioStream error:', err.message);
    cleanupInputStream();
    updateVoiceStatus(false);
  });

  activeAudioStream.on('end', () => {
    cleanupInputStream();
    silenceTimeout = setTimeout(() => updateVoiceStatus(false), 500);
  });

  activeAudioStream.pipe(currentDecoder).pipe(ffmpegIn.stdin, { end: false });
}

function setupVoiceInput(receiver) {
  console.log(`🎧 Setting up voice receiver for ${ALLOWED_USER_ID}`);

  receiver.speaking.on('start', (userId) => {
    if (userId !== ALLOWED_USER_ID) return;
    if (silenceTimeout) {
      clearTimeout(silenceTimeout);
      silenceTimeout = null;
    }
    if (activeAudioStream) return;

    console.log('🎤 [SPEAKING] user started talking');
    startUserAudioCapture(receiver);
  });

  receiver.speaking.on('end', (userId) => {
    if (userId !== ALLOWED_USER_ID) return;
    console.log('🎤 [STOPPED] user stopped talking');
    activeVoice = false;
    silenceTimeout = setTimeout(() => updateVoiceStatus(false), 800);
  });

  if (!inputKeepAliveInterval) {
    inputKeepAliveInterval = setInterval(() => {
      if (!ffmpegIn?.stdin?.writable) return;
      if (!activeVoice) {
        ffmpegIn.stdin.write(SILENCE_FRAME);
      }
    }, 20);
  }
}

async function activateGrokVoiceMode() {
  if (!page) return false;
  console.log('🎙️ Activating Grok voice mode...');

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
        await page.click(sel, { timeout: 1200 });
        await sleep(300);
      } catch {}
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
        const btn = await page.waitForSelector(sel, { timeout: 1800, state: 'visible' });
        if (btn) {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ force: true });
          clicked = true;
          console.log(`✅ voice button clicked: ${sel}`);
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
            return `match:${text.slice(0, 80)}`;
          }
        }
        return null;
      });

      if (result) {
        clicked = true;
        console.log(`✅ voice button clicked: ${result}`);
      }
    }

    await sleep(1200);

    if (context) {
      try {
        await context.grantPermissions(['microphone', 'camera'], { origin: GROK_URL });
      } catch (e) {
        console.warn('⚠️ grantPermissions:', e.message);
      }
    }

    const inVoiceMode = await page.evaluate(() => {
      const voiceUI = document.querySelector(
        '[class*="voice"], [class*="mic"], [class*="waveform"], [class*="listening"]'
      );
      const ta = document.querySelector('textarea');
      const textareaHidden = ta && ta.offsetParent === null;
      return !!voiceUI || textareaHidden;
    });

    if (inVoiceMode) {
      console.log('✅ Voice mode enabled');
      return true;
    }

    console.warn('⚠️ Voice mode not confirmed');
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
      '--disable-features=WebRtcHideLocalIpsWithMdns',
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

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
  console.log(`🔒 Allowed user: ${ALLOWED_USER_ID}`);

  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ command registration failed:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== ALLOWED_USER_ID) return;
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
    console.error('❌ messageCreate:', err.message);
    message.react('❌').catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.user.id !== ALLOWED_USER_ID) {
    return interaction.reply({ content: '❌ ليس لديك صلاحية.', ephemeral: true });
  }

  if (interaction.commandName === 'start') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '❌ انضم لقناة صوتية أولاً!', ephemeral: true });
    }
    if (browser) {
      return interaction.reply({ content: '⚠️ جلسة تعمل بالفعل!', ephemeral: true });
    }

    await interaction.reply('🔄 جاري التهيئة...');
    sessionUserId = ALLOWED_USER_ID;
    statusChannel = interaction.channel;
    statusMessage = null;

    try {
      initPlayer();

      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      connection.subscribe(player);

      await startGrokBrowser();
      ensureOutputPipeline();

      await new Promise((resolve) => {
        const state = connection.state.status;
        if (state === VoiceConnectionStatus.Ready) return resolve();

        const timer = setTimeout(() => resolve(), 10000);

        connection.once(VoiceConnectionStatus.Ready, () => {
          clearTimeout(timer);
          resolve();
        });

        connection.once(VoiceConnectionStatus.Disconnected, () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (!voiceInputReady && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        voiceInputReady = true;
        setupVoiceInput(connection.receiver);
      }

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.warn('⚠️ Voice disconnected');
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
          await entersState(connection, VoiceConnectionStatus.Ready, 10000);
        } catch {
          cleanupAll();
        }
      });

      await interaction.editReply(
        '✅ **الجلسة تعمل!**\n' +
        `🔒 للمستخدم <@${ALLOWED_USER_ID}> فقط\n` +
        '🔊 صوت Grok → Discord\n' +
        '🎤 صوتك → Grok\n' +
        '💬 اكتب هنا → يُرسل لـ Grok\n' +
        '🖥️ noVNC لمشاهدة الشاشة'
      );

      await updateVoiceStatus(false);
    } catch (error) {
      console.error('❌ start failed:', error);
      await interaction.editReply('❌ فشل: ' + error.message);
      cleanupAll();
    }
  }

  if (interaction.commandName === 'stop') {
    if (!browser) {
      return interaction.reply({ content: '⚠️ لا توجد جلسة نشطة.', ephemeral: true });
    }
    await interaction.reply('🛑 جاري الإيقاف...');
    cleanupAll();
    await interaction.editReply('✅ تم إيقاف كل شيء بنجاح.');
  }
});

function cleanupAll() {
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

  cleanupInputStream();

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
  sessionUserId = null;
  statusMessage = null;
  statusChannel = null;
  activeVoice = false;

  console.log('🧹 Cleaned up all resources');
}

process.on('SIGINT', () => {
  cleanupAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
