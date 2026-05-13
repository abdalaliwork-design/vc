process.env.DISCORDJS_NO_LAZY_LOAD = 'true';
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { addExtra }  = require('playwright-extra');
const { chromium: playwrightChromium } = require('playwright');
const chromium      = addExtra(playwrightChromium);
const stealth       = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG  — everything from env vars
// ─────────────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN    || null;
const DISCORD_EMAIL    = process.env.DISCORD_EMAIL    || null;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD || null;

// Cookie-based auth (easiest) — paste the raw cookie string from DevTools
// For Discord: copy "token" value from localStorage OR full cookie header string
// For Grok/X:  copy full cookie header string from x.com DevTools → Network tab
const DISCORD_COOKIES  = process.env.DISCORD_COOKIES  || null;   // raw cookie string OR JSON array
const GROK_COOKIES     = process.env.GROK_COOKIES     || null;   // raw cookie string OR JSON array

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || null;
const GROK_URL         = 'https://x.com/i/grok';
const VOICE_CHANNEL_NAME = process.env.VOICE_CHANNEL_NAME || 'General';
const ALLOWED_USER_ID    = process.env.ALLOWED_USER_ID    || null;

const PERSONA = {
  name:        process.env.PERSONA_NAME        || 'Alex',
  personality: process.env.PERSONA_PERSONALITY || 'a chill friend who knows everything — witty, warm, never robotic',
  traits: [
    'Talks like a real person, uses contractions, light slang is fine',
    'Throws in an emoji here and there but never overdoes it',
    'Makes jokes when appropriate, never forced',
    'Remembers the conversation context',
    'Gives direct answers, no corporate filler',
    'Never starts with "Certainly!" or "Great question!"',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
const hasDiscordAuth = DISCORD_TOKEN || DISCORD_COOKIES || (DISCORD_EMAIL && DISCORD_PASSWORD);
const hasGrokAuth    = GROK_COOKIES  || (process.env.X_USERNAME && process.env.X_PASSWORD);

if (!hasDiscordAuth) {
  console.error('❌  Need at least one Discord auth: DISCORD_TOKEN | DISCORD_COOKIES | DISCORD_EMAIL+DISCORD_PASSWORD');
  process.exit(1);
}
if (!hasGrokAuth) {
  console.warn('⚠️  No Grok auth (GROK_COOKIES or X_USERNAME+X_PASSWORD) — Grok voice will be skipped');
}
if (!DEEPSEEK_API_KEY) console.warn('⚠️  DEEPSEEK_API_KEY not set — text chat persona disabled');

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
let browser     = null;
let browserCtx  = null;
let grokPage    = null;
let discordPage = null;
let isBusy      = false;
const conversationHistory = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(emoji, ...args) { console.log(new Date().toISOString(), emoji, ...args); }

// ─────────────────────────────────────────────────────────────────────────────
//  COOKIE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a cookie string or JSON array into Playwright's cookie format.
 * Accepts:
 *   - JSON array:  [{"name":"auth","value":"xxx","domain":".x.com",...}]
 *   - Raw string:  "name=value; name2=value2"
 */
function parseCookies(raw, domain) {
  if (!raw) return [];
  raw = raw.trim();

  // Try JSON first
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      return arr.map(c => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain   || domain,
        path:     c.path     || '/',
        secure:   c.secure   !== undefined ? c.secure : true,
        httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
        sameSite: c.sameSite || 'None',
      }));
    } catch (e) {
      log('⚠️', 'Cookie JSON parse failed, trying raw string...');
    }
  }

  // Raw "key=value; key2=value2" string
  return raw.split(';').map(s => {
    const eq = s.indexOf('=');
    if (eq < 0) return null;
    return {
      name:     s.slice(0, eq).trim(),
      value:    s.slice(eq + 1).trim(),
      domain:   domain,
      path:     '/',
      secure:   true,
      httpOnly: false,
      sameSite: 'None',
    };
  }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
//  DEEPSEEK PERSONA CHAT
// ─────────────────────────────────────────────────────────────────────────────
async function chatWithDeepSeek(userMessage, channelId, userName = 'User') {
  if (!DEEPSEEK_API_KEY) return "Chat isn't set up yet — missing API key 🤷";

  if (!conversationHistory.has(channelId)) conversationHistory.set(channelId, []);
  const history = conversationHistory.get(channelId);
  history.push({ role: 'user', content: `${userName}: ${userMessage}` });
  if (history.length > 30) history.splice(0, history.length - 30);

  const system = `You are ${PERSONA.name}. Vibe: ${PERSONA.personality}.
Rules: ${PERSONA.traits.map(t => `• ${t}`).join('\n')}
You're in Discord. Keep it short (1-3 sentences), never sound like a bot.`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: system }, ...history],
        temperature: 0.92, max_tokens: 350, top_p: 0.95,
        frequency_penalty: 0.4, presence_penalty: 0.4,
      }),
    });
    if (!res.ok) { console.error('❌ DeepSeek', res.status, await res.text()); return "brain.exe crashed 😅"; }
    const data  = await res.json();
    const reply = data.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    console.error('❌ DeepSeek fetch:', err);
    return "something broke on my end, one sec";
  }
}

function resetConversation(channelId) {
  conversationHistory.delete(channelId);
  log('🔄', `Conversation reset for ${channelId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROWSER LAUNCH
// ─────────────────────────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser) return browserCtx;   // already running
  log('🌐', 'Launching browser...');

  browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--window-size=1920,1080', '--start-maximized',
    ],
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });

  browserCtx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    permissions: ['microphone', 'camera', 'notifications'],
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Mask automation fingerprints
  await browserCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3] });
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = p =>
      ['microphone', 'camera', 'notifications'].includes(p?.name)
        ? Promise.resolve({ state: 'granted', onchange: null })
        : orig(p);
  });

  log('✅', 'Browser launched');
  return browserCtx;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GROK TAB
// ─────────────────────────────────────────────────────────────────────────────
async function openGrokTab(ctx) {
  log('🤖', 'Opening Grok tab...');
  grokPage = await ctx.newPage();
  grokPage.on('dialog', d => d.dismiss().catch(() => {}));

  // Inject cookies before navigation
  if (GROK_COOKIES) {
    const cookies = parseCookies(GROK_COOKIES, '.x.com');
    if (cookies.length) {
      await ctx.addCookies(cookies);
      log('🍪', `Injected ${cookies.length} Grok/X cookies`);
    }
  }

  await grokPage.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  // If still redirected to login, try credential login
  if (grokPage.url().includes('login') || grokPage.url().includes('signin')) {
    log('🔑', 'Cookie auth failed — trying X.com credentials...');
    await loginToX(grokPage);
    await grokPage.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
  }

  const isLoggedIn = !grokPage.url().includes('login') && !grokPage.url().includes('signin');
  if (isLoggedIn) {
    log('✅', 'Grok tab ready');
    await activateGrokVoice();
  } else {
    log('⚠️', 'Grok login may have failed — continuing anyway');
  }
}

async function loginToX(page) {
  const xUser = process.env.X_USERNAME;
  const xPass = process.env.X_PASSWORD;
  if (!xUser || !xPass) { log('⚠️', 'No X credentials'); return; }
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
    log('⚠️', 'X login issue:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD TAB
// ─────────────────────────────────────────────────────────────────────────────
async function openDiscordTab(ctx) {
  log('💬', 'Opening Discord Web tab...');
  discordPage = await ctx.newPage();
  discordPage.on('dialog', d => d.dismiss().catch(() => {}));

  // Inject Discord cookies before navigation
  if (DISCORD_COOKIES) {
    const cookies = parseCookies(DISCORD_COOKIES, '.discord.com');
    if (cookies.length) {
      await ctx.addCookies(cookies);
      log('🍪', `Injected ${cookies.length} Discord cookies`);
    }
  }

  await discordPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  if (discordPage.url().includes('login')) {
    log('🔑', 'Cookie auth failed — trying other Discord auth methods...');
    await loginToDiscordWeb(discordPage);
  }

  await discordPage.waitForSelector('[class*="sidebar"], [class*="guilds"]', { timeout: 30000 }).catch(() => {});
  log('✅', 'Discord Web tab ready');
}

async function loginToDiscordWeb(page) {
  // Method 1: Token injection via localStorage
  if (DISCORD_TOKEN) {
    log('🔑', 'Injecting Discord token...');
    await page.evaluate(token => {
      const iframe = document.createElement('iframe');
      document.head.append(iframe);
      const pd = Object.getOwnPropertyDescriptor(iframe.contentWindow, 'localStorage');
      pd.get.call(iframe.contentWindow).setItem('token', `"${token}"`);
      iframe.remove();
    }, DISCORD_TOKEN);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    return;
  }

  // Method 2: Email + password
  if (DISCORD_EMAIL && DISCORD_PASSWORD) {
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
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE CHANNEL JOIN
// ─────────────────────────────────────────────────────────────────────────────
async function joinVoiceChannelWeb(channelName) {
  if (!discordPage) { log('❌', 'Discord tab not open'); return false; }
  log('🔊', `Joining voice channel: ${channelName}`);
  try {
    const channelEl = await discordPage.waitForSelector(
      `[class*="channel"] [class*="name"]:text-is("${channelName}"), a[href*="channels"]:has-text("${channelName}")`,
      { timeout: 10000 }
    );
    await channelEl.click();
    await sleep(2000);

    const micBtn = discordPage.locator('button:has-text("Allow"), button:has-text("Grant Access")');
    if (await micBtn.count() > 0) await micBtn.first().click();

    log('✅', `Joined voice channel: ${channelName}`);
    return true;
  } catch (err) {
    log('❌', 'Could not join voice channel:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GROK VOICE ACTIVATION
// ─────────────────────────────────────────────────────────────────────────────
async function activateGrokVoice() {
  if (!grokPage) return false;
  log('🎙️', 'Activating Grok voice mode...');
  try {
    await grokPage.waitForTimeout(2000);
    const activated = await grokPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
        if (label.includes('voice') || label.includes('talk') || label.includes('speak')) {
          btn.click(); return true;
        }
      }
      return false;
    });
    if (activated) { log('✅', 'Grok voice activated'); await sleep(2000); return true; }
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

// ─────────────────────────────────────────────────────────────────────────────
//  SEND TO GROK
// ─────────────────────────────────────────────────────────────────────────────
async function sendToGrok(text) {
  if (!grokPage || isBusy) return false;
  isBusy = true;
  log('📨', `Sending to Grok: "${text}"`);
  try {
    const selectors = ['textarea[placeholder]', 'div[contenteditable="true"]', '[data-testid="chat-input"]', 'textarea'];
    let input = null;
    for (const sel of selectors) {
      input = await grokPage.$(sel);
      if (input && await input.isVisible()) break;
      input = null;
    }
    if (!input) { log('❌', 'Grok input not found'); return false; }
    await input.click();
    await sleep(200);
    await grokPage.keyboard.press('Control+a');
    await grokPage.keyboard.type(text, { delay: 25 });
    await grokPage.keyboard.press('Enter');
    log('✅', 'Sent to Grok');
    await sleep(2000);
    return true;
  } catch (err) {
    log('❌', 'sendToGrok error:', err.message);
    return false;
  } finally {
    isBusy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-START  ← runs immediately on deploy
// ─────────────────────────────────────────────────────────────────────────────
async function autoStart() {
  log('🚀', 'Auto-starting browser session...');
  try {
    const ctx = await launchBrowser();

    if (hasGrokAuth) {
      await openGrokTab(ctx);
    } else {
      log('⚠️', 'Skipping Grok tab (no auth)');
    }

    await openDiscordTab(ctx);
    await joinVoiceChannelWeb(VOICE_CHANNEL_NAME);

    log('🎉', '══════════════════════════════════════════════');
    log('🎉', `  ${PERSONA.name} is LIVE in #${VOICE_CHANNEL_NAME}`);
    log('🎉', '  noVNC → http://YOUR_HOST:6080/vnc.html?autoconnect=true&resize=scale');
    log('🎉', '══════════════════════════════════════════════');
  } catch (err) {
    log('❌', 'Auto-start failed:', err.message);
    // Retry after 15s
    log('🔄', 'Retrying in 15s...');
    setTimeout(autoStart, 15000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD BOT (slash commands + message handler)
// ─────────────────────────────────────────────────────────────────────────────
async function startDiscordBot() {
  if (!DISCORD_TOKEN) {
    log('ℹ️', 'No DISCORD_TOKEN — slash commands unavailable (browser-only mode)');
    return;
  }

  const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  const commands = [
    { name: 'restart', description: '🔄 Restart the browser session' },
    { name: 'stop',    description: '🛑 Stop the browser session' },
    { name: 'ask',     description: '💬 Ask Grok something (voice response in channel)' },
    { name: 'chat',    description: '🗣️ Chat with the AI persona (text reply)' },
    { name: 'reset',   description: '🔄 Reset conversation memory' },
    { name: 'status',  description: '📊 Check bot status' },
  ];

  client.once('ready', async () => {
    log('✅', `Discord bot logged in as ${client.user.tag}`);
    await client.application.commands.set(commands);
    log('✅', 'Slash commands registered');
  });

  // Natural message → Grok or DeepSeek
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) return;
    const text = message.content.trim();
    if (!text || text.startsWith('/')) return;

    if (grokPage && !isBusy) {
      try {
        await message.react('⏳');
        await sendToGrok(text);
        await message.reactions.cache.get('⏳')?.remove().catch(() => {});
        await message.react('🔊');
      } catch { await message.react('❌'); }
    } else if (DEEPSEEK_API_KEY) {
      try {
        await message.channel.sendTyping();
        const reply = await chatWithDeepSeek(text, message.channel.id, message.author.username);
        await message.reply(reply);
      } catch (err) { log('❌', 'Chat error:', err); }
    }
  });

  // Slash commands
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (ALLOWED_USER_ID && interaction.user.id !== ALLOWED_USER_ID)
      return interaction.reply({ content: '🚫 No permission.', flags: MessageFlags.Ephemeral });

    const cmd = interaction.commandName;

    if (cmd === 'restart') {
      await interaction.reply('🔄 Restarting browser session...');
      cleanupBrowser();
      await sleep(2000);
      try {
        await autoStart();
        await interaction.editReply('✅ Session restarted!');
      } catch (err) {
        await interaction.editReply('❌ Restart failed: ' + err.message);
      }
    }

    if (cmd === 'stop') {
      if (!browser) return interaction.reply({ content: '⚠️ Nothing running.', flags: MessageFlags.Ephemeral });
      await interaction.reply('🛑 Shutting down...');
      cleanupBrowser();
      await interaction.editReply('✅ Stopped.');
    }

    if (cmd === 'ask') {
      if (!grokPage) return interaction.reply({ content: '❌ Grok tab not open', flags: MessageFlags.Ephemeral });
      await interaction.showModal({
        customId: 'askModal', title: '💬 Ask Grok',
        components: [{ type: 1, components: [{ type: 4, customId: 'askText', label: 'Your question',
          style: 2, placeholder: 'Ask Grok anything...', required: true, maxLength: 500 }] }],
      });
    }

    if (cmd === 'chat') {
      if (!DEEPSEEK_API_KEY) return interaction.reply({ content: '❌ No DeepSeek key', flags: MessageFlags.Ephemeral });
      await interaction.showModal({
        customId: 'chatModal', title: `💬 Chat with ${PERSONA.name}`,
        components: [{ type: 1, components: [{ type: 4, customId: 'chatText', label: 'Your message',
          style: 2, placeholder: `Say something to ${PERSONA.name}...`, required: true, maxLength: 500 }] }],
      });
    }

    if (cmd === 'reset') {
      resetConversation(interaction.channel.id);
      await interaction.reply({ content: '🔄 Memory wiped — fresh start!', flags: MessageFlags.Ephemeral });
    }

    if (cmd === 'status') {
      const uptime = process.uptime();
      const hh = Math.floor(uptime / 3600), mm = Math.floor((uptime % 3600) / 60), ss = Math.floor(uptime % 60);
      const lines = [
        `🤖 **${PERSONA.name}** — ${browser ? '🟢 Running' : '🔴 Stopped'}`,
        `🌐 Browser  : ${browser     ? '✅ Open' : '❌ Closed'}`,
        `🎙️ Grok tab : ${grokPage    ? '✅ Open' : '❌ Closed'}`,
        `💬 Discord  : ${discordPage ? '✅ Open' : '❌ Closed'}`,
        `🧠 DeepSeek : ${DEEPSEEK_API_KEY ? '✅ Enabled' : '❌ Disabled'}`,
        `🔒 Access   : ${ALLOWED_USER_ID  ? `User ${ALLOWED_USER_ID} only` : 'Everyone'}`,
        `⏱️ Uptime   : ${hh}h ${mm}m ${ss}s`,
      ];
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
  });

  // Modal submissions
  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId === 'askModal') {
      const text = interaction.fields.getTextInputValue('askText');
      await interaction.reply('⏳ Sending to Grok...');
      const ok = await sendToGrok(text);
      await interaction.editReply(ok ? '🔊 Grok is responding!' : '❌ Failed to reach Grok.');
    }
    if (interaction.customId === 'chatModal') {
      const text = interaction.fields.getTextInputValue('chatText');
      await interaction.reply('💭 Thinking...');
      const reply = await chatWithDeepSeek(text, interaction.channel.id, interaction.user.username);
      await interaction.editReply(reply);
    }
  });

  await client.login(DISCORD_TOKEN);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLEANUP
// ─────────────────────────────────────────────────────────────────────────────
function cleanupBrowser() {
  isBusy = false;
  if (browser) { browser.close().catch(() => {}); browser = null; }
  browserCtx  = null;
  grokPage    = null;
  discordPage = null;
  log('🧹', 'Browser resources cleaned up');
}

process.on('SIGINT',  () => { cleanupBrowser(); process.exit(0); });
process.on('SIGTERM', () => { cleanupBrowser(); process.exit(0); });
process.on('unhandledRejection', err => log('❌', 'unhandledRejection:', err));
process.on('uncaughtException',  err => log('❌', 'uncaughtException:',  err));

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN  — starts everything on deploy
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('🚀', `Booting ${PERSONA.name}...`);

  // Start Discord bot (for slash commands) in parallel
  const botPromise = startDiscordBot().catch(err => log('❌', 'Discord bot error:', err));

  // Auto-start browser session immediately
  await autoStart();

  await botPromise;
}

main();
