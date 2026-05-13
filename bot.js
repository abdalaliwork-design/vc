process.env.DISCORDJS_NO_LAZY_LOAD = 'true';
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { addExtra } = require('playwright-extra');
const { chromium: playwrightChromium } = require('playwright');
const chromium = addExtra(playwrightChromium);
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const DISCORD_EMAIL   = process.env.DISCORD_EMAIL;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GROK_URL        = process.env.GROK_URL || 'https://x.com/i/grok';
const VOICE_CHANNEL_NAME = process.env.VOICE_CHANNEL_NAME || 'General';
const TEXT_CHANNEL_NAME  = process.env.TEXT_CHANNEL_NAME  || 'general';
const ALLOWED_USER_ID    = process.env.ALLOWED_USER_ID    || null;

const PERSONA = {
  name: process.env.PERSONA_NAME || 'Alex',
  personality: process.env.PERSONA_PERSONALITY || 'a chill friend who happens to know everything — witty, warm, never robotic',
  traits: [
    'Talks like a real person, uses contractions, slang is fine',
    'Throws in an emoji here and there but never overdoes it',
    'Makes jokes when appropriate, never forced',
    'Remembers what was said earlier in the conversation',
    'Gives direct answers, no corporate filler phrases',
    'If asked something impossible, plays it off with humor',
    'Never starts a response with "Certainly!" or "Great question!"',
  ],
};

if (!DISCORD_TOKEN && !(DISCORD_EMAIL && DISCORD_PASSWORD)) {
  console.error('❌  Need DISCORD_TOKEN (bot) or DISCORD_EMAIL+DISCORD_PASSWORD (web login)');
  process.exit(1);
}
if (!DEEPSEEK_API_KEY) console.warn('⚠️  DEEPSEEK_API_KEY not set — text chat persona disabled');

// ── State ────────────────────────────────────────────────────────────────────
let browser      = null;
let grokPage     = null;
let discordPage  = null;
let isBusy       = false;
const conversationHistory = new Map(); // channelId → messages[]

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(emoji, ...args) { console.log(emoji, ...args); }

// ── DeepSeek Chat ─────────────────────────────────────────────────────────────
async function chatWithDeepSeek(userMessage, channelId, userName = 'User') {
  if (!DEEPSEEK_API_KEY) return "Chat isn't set up yet — missing API key 🤷";

  if (!conversationHistory.has(channelId)) conversationHistory.set(channelId, []);
  const history = conversationHistory.get(channelId);

  history.push({ role: 'user', content: `${userName}: ${userMessage}` });
  if (history.length > 30) history.splice(0, history.length - 30);

  const system = `You are ${PERSONA.name}. Your vibe: ${PERSONA.personality}.

Rules you live by:
${PERSONA.traits.map(t => `• ${t}`).join('\n')}

You're in a Discord server. Keep it real, keep it short (1-3 sentences usually), and never sound like a customer service bot.`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: system }, ...history],
        temperature: 0.92,
        max_tokens: 350,
        top_p: 0.95,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
      }),
    });

    if (!res.ok) {
      console.error('❌ DeepSeek error', res.status, await res.text());
      return "brain.exe stopped working, try again 😅";
    }

    const data = await res.json();
    const reply = data.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    console.error('❌ DeepSeek fetch error:', err);
    return "something broke on my end, one sec";
  }
}

function resetConversation(channelId) {
  conversationHistory.delete(channelId);
  log('🔄', `Conversation reset for channel ${channelId}`);
}

// ── Browser Launch ────────────────────────────────────────────────────────────
async function launchBrowser() {
  log('🌐', 'Launching browser...');
  browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      // Allow the browser to use PulseAudio virtual devices
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--window-size=1920,1080',
      '--start-maximized',
    ],
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });

  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    permissions: ['microphone', 'camera', 'notifications'],
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Mask automation fingerprints
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = p =>
      ['microphone', 'camera', 'notifications'].includes(p?.name)
        ? Promise.resolve({ state: 'granted', onchange: null })
        : orig(p);
  });

  return ctx;
}

// ── Grok Tab ──────────────────────────────────────────────────────────────────
async function openGrokTab(ctx) {
  log('🤖', 'Opening Grok tab...');
  grokPage = await ctx.newPage();
  grokPage.on('dialog', d => d.dismiss().catch(() => {}));

  await grokPage.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  // If we need X.com login first
  if (grokPage.url().includes('login') || grokPage.url().includes('signin')) {
    log('🔑', 'X.com login required for Grok...');
    await loginToX(grokPage);
    await grokPage.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
  }

  log('✅', 'Grok tab ready');
}

async function loginToX(page) {
  const xUser = process.env.X_USERNAME || process.env.DISCORD_EMAIL;
  const xPass = process.env.X_PASSWORD || process.env.DISCORD_PASSWORD;
  if (!xUser || !xPass) {
    log('⚠️', 'No X credentials — Grok may not be accessible');
    return;
  }

  try {
    await page.waitForSelector('input[autocomplete="username"], input[name="text"]', { timeout: 10000 });
    await page.fill('input[autocomplete="username"], input[name="text"]', xUser);
    await page.keyboard.press('Enter');
    await sleep(1500);

    const passField = await page.waitForSelector('input[type="password"]', { timeout: 8000 });
    await passField.fill(xPass);
    await page.keyboard.press('Enter');
    await sleep(3000);
    log('✅', 'X.com login submitted');
  } catch (err) {
    log('⚠️', 'X login flow issue:', err.message);
  }
}

// ── Discord Web Tab ───────────────────────────────────────────────────────────
async function openDiscordTab(ctx) {
  log('💬', 'Opening Discord Web tab...');
  discordPage = await ctx.newPage();
  discordPage.on('dialog', d => d.dismiss().catch(() => {}));

  await discordPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  // Login if needed
  if (discordPage.url().includes('login')) {
    log('🔑', 'Logging into Discord Web...');
    await loginToDiscordWeb(discordPage);
  }

  // Wait for app to load
  await discordPage.waitForSelector('[class*="sidebar"], [class*="guilds"]', { timeout: 30000 }).catch(() => {});
  log('✅', 'Discord Web tab ready');
}

async function loginToDiscordWeb(page) {
  // Token-based login is fastest and most reliable
  if (DISCORD_TOKEN) {
    log('🔑', 'Injecting Discord token...');
    await page.evaluate(token => {
      function setToken(token) {
        const iframe = document.createElement('iframe');
        document.head.append(iframe);
        const pd = Object.getOwnPropertyDescriptor(iframe.contentWindow, 'localStorage');
        pd.get.call(iframe.contentWindow).setItem('token', `"${token}"`);
        iframe.remove();
      }
      setToken(token);
    }, DISCORD_TOKEN);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    return;
  }

  // Email/password fallback
  try {
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    await page.fill('input[name="email"]', DISCORD_EMAIL);
    await page.fill('input[name="password"]', DISCORD_PASSWORD);
    await page.click('button[type="submit"]');
    await sleep(4000);
    log('✅', 'Discord login submitted');
  } catch (err) {
    log('❌', 'Discord login error:', err.message);
  }
}

// ── Join Voice Channel via Discord Web ────────────────────────────────────────
async function joinVoiceChannelWeb(channelName) {
  if (!discordPage) throw new Error('Discord tab not open');
  log('🔊', `Looking for voice channel: ${channelName}`);

  try {
    // Find channel by name in sidebar
    const channelEl = await discordPage.waitForSelector(
      `[class*="channel"] [class*="name"]:text-is("${channelName}"), a[href*="channels"]:has-text("${channelName}")`,
      { timeout: 10000 }
    );
    await channelEl.click();
    await sleep(2000);

    // Grant mic permission popup if shown
    const micBtn = discordPage.locator('button:has-text("Allow"), button:has-text("Grant Access")');
    if (await micBtn.count() > 0) await micBtn.first().click();

    // Set input device to VirtualMic if Discord shows device picker
    await setDiscordAudioDevices();

    log('✅', `Joined voice channel: ${channelName}`);
    return true;
  } catch (err) {
    log('❌', 'Could not join voice channel:', err.message);
    return false;
  }
}

async function setDiscordAudioDevices() {
  // Open Voice Settings and select VirtualMic as input
  try {
    await discordPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded' });
    // Open user settings
    await discordPage.click('[aria-label="User Settings"], [class*="settings"]').catch(() => {});
    await sleep(1000);
    // Navigate to Voice & Video
    await discordPage.click('text=Voice & Video').catch(() => {});
    await sleep(800);

    // Set Input Device to VirtualMic
    const inputSelect = discordPage.locator('select, [class*="select"]').filter({ hasText: /input/i }).first();
    if (await inputSelect.count() > 0) {
      // Try to find VirtualMic option
      await inputSelect.selectOption({ label: /VirtualMic|virtual/i }).catch(() => {});
      log('✅', 'Set input device to VirtualMic');
    }

    // Close settings
    await discordPage.keyboard.press('Escape');
    await sleep(500);
  } catch (err) {
    log('⚠️', 'Could not configure audio devices via UI:', err.message);
  }
}

// ── Send text to Grok and let it speak ───────────────────────────────────────
async function sendToGrok(text) {
  if (!grokPage || isBusy) return false;
  isBusy = true;
  log('📨', `Sending to Grok: "${text}"`);

  try {
    // Find the Grok textarea
    const selectors = [
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      '[data-testid="chat-input"]',
      'textarea',
    ];

    let input = null;
    for (const sel of selectors) {
      input = await grokPage.$(sel);
      if (input && await input.isVisible()) break;
      input = null;
    }

    if (!input) {
      log('❌', 'Grok input not found');
      return false;
    }

    await input.click();
    await sleep(200);
    // Clear existing text
    await grokPage.keyboard.press('Control+a');
    await grokPage.keyboard.type(text, { delay: 25 });
    await grokPage.keyboard.press('Enter');
    log('✅', 'Sent to Grok — waiting for voice response...');

    // Give Grok time to respond with audio
    await sleep(2000);
    return true;
  } catch (err) {
    log('❌', 'sendToGrok error:', err.message);
    return false;
  } finally {
    isBusy = false;
  }
}

// ── Activate Grok Voice Mode ──────────────────────────────────────────────────
async function activateGrokVoice() {
  if (!grokPage) return false;
  log('🎙️', 'Activating Grok voice mode...');

  try {
    await grokPage.waitForTimeout(2000);

    // Look for voice/talk button
    const activated = await grokPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
        if (label.includes('voice') || label.includes('talk') || label.includes('speak')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (activated) {
      log('✅', 'Grok voice button clicked');
      await sleep(2000);
      return true;
    }

    // Keyboard shortcut fallback
    await grokPage.keyboard.down('Control');
    await grokPage.keyboard.down('Shift');
    await grokPage.keyboard.press('O');
    await grokPage.keyboard.up('Shift');
    await grokPage.keyboard.up('Control');
    await sleep(2000);
    log('✅', 'Sent Ctrl+Shift+O voice shortcut');
    return true;
  } catch (err) {
    log('❌', 'Voice activation error:', err.message);
    return false;
  }
}

// ── Discord Bot (for commands & chat) ─────────────────────────────────────────
// We use a minimal HTTP-polling approach so we don't need discord.js at all
// if the user prefers pure browser mode. But we support both modes.

let discordBotClient = null;

async function startDiscordBot() {
  if (!DISCORD_TOKEN) {
    log('ℹ️', 'No DISCORD_TOKEN — running in browser-only mode');
    return;
  }

  const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
  discordBotClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  const commands = [
    { name: 'start',  description: '🎤 Start Grok voice session in your voice channel' },
    { name: 'stop',   description: '🛑 Stop the voice session' },
    { name: 'ask',    description: '💬 Ask Grok something (voice response in channel)' },
    { name: 'chat',   description: '🗣️ Chat with the AI persona (text reply)' },
    { name: 'reset',  description: '🔄 Reset conversation memory' },
    { name: 'status', description: '📊 Check bot status' },
  ];

  discordBotClient.once('ready', async () => {
    log('✅', `Discord bot logged in as ${discordBotClient.user.tag}`);
    await discordBotClient.application.commands.set(commands);
    log('✅', 'Slash commands registered');
  });

  // Natural message handler
  discordBotClient.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) return;
    const text = message.content.trim();
    if (!text || text.startsWith('/')) return;

    // Route: if Grok session active → Grok, else → DeepSeek persona
    if (grokPage && !isBusy) {
      try {
        await message.react('⏳');
        await sendToGrok(text);
        await message.reactions.cache.get('⏳')?.remove().catch(() => {});
        await message.react('🔊');
      } catch {
        await message.react('❌');
      }
    } else if (DEEPSEEK_API_KEY) {
      try {
        await message.channel.sendTyping();
        const reply = await chatWithDeepSeek(text, message.channel.id, message.author.username);
        await message.reply(reply);
      } catch (err) {
        log('❌', 'Chat error:', err);
      }
    }
  });

  // Command handler
  discordBotClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (ALLOWED_USER_ID && interaction.user.id !== ALLOWED_USER_ID) {
      return interaction.reply({ content: '🚫 No permission.', flags: MessageFlags.Ephemeral });
    }

    const cmd = interaction.commandName;

    if (cmd === 'start') {
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.reply({ content: '❌ Join a voice channel first!', flags: MessageFlags.Ephemeral });
      if (browser)  return interaction.reply({ content: '⚠️ Session already running!', flags: MessageFlags.Ephemeral });

      await interaction.reply('🔄 Starting up... hang tight');

      try {
        const ctx = await launchBrowser();
        await openGrokTab(ctx);
        await activateGrokVoice();
        await openDiscordTab(ctx);
        await joinVoiceChannelWeb(vc.name);

        await interaction.editReply(
          `✅ **Live!** Grok is in **${vc.name}**\n` +
          `🎤 Speak or type — Grok responds with voice\n` +
          `💬 Text messages → Grok voice response\n` +
          `🖥️ View browser: noVNC on port 6080`
        );
      } catch (err) {
        log('❌', 'Start failed:', err);
        await interaction.editReply('❌ Failed: ' + err.message);
        cleanupAll();
      }
    }

    if (cmd === 'stop') {
      if (!browser) return interaction.reply({ content: '⚠️ Nothing running.', flags: MessageFlags.Ephemeral });
      await interaction.reply('🛑 Shutting down...');
      cleanupAll();
      await interaction.editReply('✅ Stopped.');
    }

    if (cmd === 'ask') {
      if (!grokPage) return interaction.reply({ content: '❌ Start a session first with /start', flags: MessageFlags.Ephemeral });

      await interaction.showModal({
        customId: 'askModal',
        title: '💬 Ask Grok',
        components: [{
          type: 1,
          components: [{
            type: 4,
            customId: 'askText',
            label: 'Your question',
            style: 2,
            placeholder: 'Ask Grok anything...',
            required: true,
            maxLength: 500,
          }],
        }],
      });
    }

    if (cmd === 'chat') {
      if (!DEEPSEEK_API_KEY) return interaction.reply({ content: '❌ DeepSeek API key not configured.', flags: MessageFlags.Ephemeral });
      await interaction.showModal({
        customId: 'chatModal',
        title: `💬 Chat with ${PERSONA.name}`,
        components: [{
          type: 1,
          components: [{
            type: 4,
            customId: 'chatText',
            label: 'Your message',
            style: 2,
            placeholder: `Say something to ${PERSONA.name}...`,
            required: true,
            maxLength: 500,
          }],
        }],
      });
    }

    if (cmd === 'reset') {
      resetConversation(interaction.channel.id);
      await interaction.reply({ content: '🔄 Memory wiped — fresh start!', flags: MessageFlags.Ephemeral });
    }

    if (cmd === 'status') {
      const lines = [
        `🤖 **${PERSONA.name}** is ${browser ? '🟢 Online' : '🔴 Offline'}`,
        `🌐 Browser: ${browser ? 'Running' : 'Stopped'}`,
        `🎙️ Grok tab: ${grokPage ? '✅ Open' : '❌ Closed'}`,
        `💬 Discord tab: ${discordPage ? '✅ Open' : '❌ Closed'}`,
        `🧠 DeepSeek chat: ${DEEPSEEK_API_KEY ? '✅ Enabled' : '❌ Disabled'}`,
        `🔒 Access: ${ALLOWED_USER_ID ? `User ${ALLOWED_USER_ID} only` : 'Everyone'}`,
      ];
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
  });

  // Modal handlers
  discordBotClient.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === 'askModal') {
      const text = interaction.fields.getTextInputValue('askText');
      await interaction.reply('⏳ Sending to Grok...');
      const ok = await sendToGrok(text);
      await interaction.editReply(ok ? '🔊 Grok is responding with voice!' : '❌ Failed to reach Grok.');
    }

    if (interaction.customId === 'chatModal') {
      const text = interaction.fields.getTextInputValue('chatText');
      await interaction.reply('💭 Thinking...');
      const reply = await chatWithDeepSeek(text, interaction.channel.id, interaction.user.username);
      await interaction.editReply(reply);
    }
  });

  await discordBotClient.login(DISCORD_TOKEN);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanupAll() {
  isBusy = false;
  if (browser) { browser.close().catch(() => {}); browser = null; }
  grokPage = null;
  discordPage = null;
  log('🧹', 'All resources cleaned up');
}

process.on('SIGINT',  () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
process.on('unhandledRejection', err => log('❌', 'unhandledRejection:', err));
process.on('uncaughtException',  err => log('❌', 'uncaughtException:', err));

// ── Entry Point ───────────────────────────────────────────────────────────────
async function main() {
  log('🚀', `Starting ${PERSONA.name} bot...`);

  // Start the discord.js bot for commands regardless
  await startDiscordBot();

  // If no bot token, launch browser immediately and rely on web automation
  if (!DISCORD_TOKEN && DISCORD_EMAIL && DISCORD_PASSWORD) {
    const ctx = await launchBrowser();
    await openGrokTab(ctx);
    await activateGrokVoice();
    await openDiscordTab(ctx);
    await joinVoiceChannelWeb(VOICE_CHANNEL_NAME);
    log('✅', 'Full browser-only mode running');
  }
}

main();
