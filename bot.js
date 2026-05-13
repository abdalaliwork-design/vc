process.env.DISCORDJS_NO_LAZY_LOAD = 'true';
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { addExtra }  = require('playwright-extra');
const { chromium: playwrightChromium } = require('playwright');
const chromium      = addExtra(playwrightChromium);
const stealth       = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN    || null;
const DISCORD_EMAIL    = process.env.DISCORD_EMAIL    || null;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD || null;
const DISCORD_COOKIES  = process.env.DISCORD_COOKIES  || null;
const MILO_TOKEN       = process.env.MILO_TOKEN       || null; // Milo's user token (bypasses login page)
const GROK_COOKIES     = process.env.GROK_COOKIES     || null;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || null;
const GROK_URL         = 'https://grok.com';

// Milo's real Discord account ID (the browser session account)
const MILO_ACCOUNT_ID = process.env.MILO_ACCOUNT_ID || '1504162446196080754';

// Only this user (you) can tag Milo and trigger responses
const OWNER_ID = '712321588342816879';

const PERSONA = {
  name:        process.env.PERSONA_NAME        || 'Milo',
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
const hasGrokAuth    = !!GROK_COOKIES;

if (!hasDiscordAuth) {
  console.error('❌  Need at least one Discord auth: DISCORD_TOKEN | DISCORD_COOKIES | DISCORD_EMAIL+DISCORD_PASSWORD');
  process.exit(1);
}
if (!hasGrokAuth)      console.warn('⚠️  GROK_COOKIES not set — Grok voice will be skipped');
if (!DEEPSEEK_API_KEY) console.warn('⚠️  DEEPSEEK_API_KEY not set — text replies disabled');

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
//  TAG HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Check if the message tags Milo (by mention, account ID text, or @name)
function isMiloTagged(content) {
  return (
    content.includes(`<@${MILO_ACCOUNT_ID}>`)   ||
    content.includes(`<@!${MILO_ACCOUNT_ID}>`)  ||
    content.toLowerCase().includes(`@${PERSONA.name.toLowerCase()}`)
  );
}

// Strip the Milo tag out to get the actual command text
function stripMiloTag(content) {
  return content
    .replace(new RegExp(`<@!?${MILO_ACCOUNT_ID}>`, 'g'), '')
    .replace(new RegExp(`@${PERSONA.name}`, 'gi'), '')
    .trim();
}

// Detect "join vc" intent in all common phrasings
function isJoinVcIntent(text) {
  const lower = text.toLowerCase();
  return (
    lower === '' ||
    lower.includes('join the vc')  ||
    lower.includes('join vc')      ||
    lower.includes('join voice')   ||
    lower.includes('come to vc')   ||
    lower.includes('get in vc')    ||
    lower.includes('hop in vc')    ||
    lower.includes('come here')    ||
    lower.includes('get in here')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  COOKIE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Playwright only accepts 'Strict' | 'Lax' | 'None'.
// Cookie exporters (EditThisCookie, Cookie-Editor, etc.) often produce values
// like 'no_restriction', 'lax', 'strict', 'unspecified', '', null, undefined.
function normalizeSameSite(value) {
  if (!value) return 'None';
  switch (value.toLowerCase().replace(/[_\-\s]/g, '')) {
    case 'strict':        return 'Strict';
    case 'lax':           return 'Lax';
    case 'none':
    case 'norestriction': return 'None';
    default:              return 'None';
  }
}

function parseCookies(raw, domain) {
  if (!raw) return [];
  raw = raw.trim();

  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      return arr.map(c => {
        // hostOnly cookies exported as "grok.com" need a leading dot for Playwright
        // unless they really are host-only (no dot), in which case keep as-is
        const cookieDomain = c.domain || domain;
        const cookie = {
          name:     c.name,
          value:    c.value,
          domain:   cookieDomain,
          path:     c.path     || '/',
          secure:   c.secure   !== undefined ? c.secure   : true,
          httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
          sameSite: normalizeSameSite(c.sameSite),
        };
        // Map expirationDate (cookie exporter format) → expires (Playwright format)
        const exp = c.expires ?? c.expirationDate;
        if (exp && !c.session) cookie.expires = Math.floor(exp);
        return cookie;
      }).filter(c => c.name && c.value !== undefined);
    } catch (e) {
      log('⚠️', 'Cookie JSON parse failed, trying raw string...');
    }
  }

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
//  DEEPSEEK CHAT
// ─────────────────────────────────────────────────────────────────────────────
async function chatWithDeepSeek(userMessage, channelId, userName = 'User') {
  if (!DEEPSEEK_API_KEY) return "no brain rn — DEEPSEEK_API_KEY missing 🤷";

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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: system }, ...history],
        temperature: 0.92, max_tokens: 350, top_p: 0.95,
        frequency_penalty: 0.4, presence_penalty: 0.4,
      }),
    });
    if (!res.ok) {
      console.error('❌ DeepSeek', res.status, await res.text());
      return "brain.exe crashed 😅";
    }
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
  log('🔄', `Conversation reset for channel ${channelId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROWSER LAUNCH
// ─────────────────────────────────────────────────────────────────────────────
async function launchBrowser() {
  // If the browser process died (e.g. OOM, crash), treat it as gone
  if (browser) {
    try { browser.contexts(); } // throws if browser is closed
    catch (_) { cleanupBrowser(); }
  }
  if (browser) return browserCtx;
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
//  GROK TAB  (cookie-only, no X credentials needed)
// ─────────────────────────────────────────────────────────────────────────────
async function openGrokTab(ctx) {
  log('🤖', 'Opening Grok tab...');
  grokPage = await ctx.newPage();
  grokPage.on('dialog', d => d.dismiss().catch(() => {}));

  const cookies = parseCookies(GROK_COOKIES, '.x.com');
  if (cookies.length) {
    await ctx.addCookies(cookies);
    log('🍪', `Injected ${cookies.length} Grok cookies`);
  }

  await grokPage.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  const isLoggedIn = !grokPage.url().includes('login') && !grokPage.url().includes('signin');
  if (isLoggedIn) {
    log('✅', 'Grok tab ready');
    await activateGrokVoice();
  } else {
    log('⚠️', 'Grok login failed — check your GROK_COOKIES');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD TAB
// ─────────────────────────────────────────────────────────────────────────────
async function openDiscordTab(ctx) {
  log('💬', 'Opening Discord Web tab (Milo account)...');
  discordPage = await ctx.newPage();
  discordPage.on('dialog', d => d.dismiss().catch(() => {}));

  // ── Method 1: MILO_TOKEN — inject directly into localStorage (best, bypasses login page) ──
  if (MILO_TOKEN) {
    log('🔑', 'Injecting Milo user token into Discord localStorage...');
    // Must wait for 'load' (not just domcontentloaded) so window.localStorage is defined
    await discordPage.goto('https://discord.com', { waitUntil: 'load', timeout: 30000 });
    await discordPage.evaluate(token => {
      window.localStorage.setItem('token', `"${token}"`);
    }, MILO_TOKEN);
    // Now navigate to /app — Discord reads the token and loads without a login page
    await discordPage.goto('https://discord.com/app', { waitUntil: 'load', timeout: 60000 });
    await sleep(3000);

    if (!discordPage.url().includes('login')) {
      log('✅', 'Discord logged in via MILO_TOKEN');
      await discordPage.waitForSelector('[class*="sidebar"], [class*="guilds"]', { timeout: 20000 }).catch(() => {});
      log('✅', 'Discord Web tab ready (Milo is online)');
      return;
    }
    log('⚠️', 'MILO_TOKEN injection did not work — token may be expired');
  }

  // ── Method 2: Saved browser profile session (persists after first manual login) ──
  await discordPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  if (!discordPage.url().includes('login') && !discordPage.url().includes('register')) {
    log('✅', 'Discord logged in via saved browser session');
    await discordPage.waitForSelector('[class*="sidebar"], [class*="guilds"]', { timeout: 20000 }).catch(() => {});
    log('✅', 'Discord Web tab ready (Milo is online)');
    return;
  }

  // ── Method 3: Email + password (may hit Cloudflare on fresh IPs) ──
  if (DISCORD_EMAIL && DISCORD_PASSWORD) {
    log('🔑', 'Trying email/password login...');
    await loginToDiscordWeb(discordPage);
    await sleep(4000);
    if (!discordPage.url().includes('login')) {
      log('✅', 'Discord Web tab ready (Milo is online)');
      return;
    }
  }

  // ── Method 4: Manual login via noVNC — wait up to 5 minutes ──
  log('⚠️', '══════════════════════════════════════════════════════════════');
  log('⚠️', ' Discord login blocked (Cloudflare). Two options:');
  log('⚠️', '');
  log('⚠️', ' OPTION A (permanent fix):');
  log('⚠️', '   Get Milo\'s token from a logged-in browser console:');
  log('⚠️', '   (webpackChunkdiscord_app.push([[\'\'  ],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m)');
  log('⚠️', '   .find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()');
  log('⚠️', '   Then add it to Railway as: MILO_TOKEN=<token>');
  log('⚠️', '');
  log('⚠️', ' OPTION B (one-time manual):');
  log('⚠️', '   Open noVNC and use the QR code to log in with your phone:');
  log('⚠️', '   http://YOUR_HOST:6080/vnc.html?autoconnect=true&resize=scale');
  log('⚠️', '   Waiting 5 minutes...');
  log('⚠️', '══════════════════════════════════════════════════════════════');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    if (!discordPage.url().includes('login') && !discordPage.url().includes('register')) {
      log('✅', 'Manual Discord login detected!');
      // Save token to persistent localStorage for next restart
      try {
        const savedToken = await discordPage.evaluate(() => {
          return (webpackChunkdiscord_app
            ?.flatMap(c => Object.values(c[1] || {}))
            ?.find(m => m?.exports?.default?.getToken)
            ?.exports?.default?.getToken()) || null;
        });
        if (savedToken) log('💾', `Add this to Railway as MILO_TOKEN to skip manual login next time:\n  ${savedToken}`);
      } catch (_) {}
      break;
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    if (remaining % 30 === 0) log('⏳', `Still waiting for manual Discord login... ${remaining}s left`);
  }

  const appReady = await discordPage.waitForSelector(
    '[class*="sidebar"], [class*="guilds"]', { timeout: 10000 }
  ).catch(() => null);

  if (appReady) {
    log('✅', 'Discord Web tab ready (Milo is online)');
  } else {
    log('❌', 'Discord login failed — bot will run without Discord browser tab');
  }
}

async function loginToDiscordWeb(page) {
  // Try 1: Token injection into localStorage (Discord has partially patched this,
  // so we verify it actually worked before giving up on email/pass fallback)
  if (DISCORD_TOKEN) {
    log('🔑', 'Trying Discord token injection...');
    try {
      await page.evaluate(token => {
        try {
          window.localStorage.setItem('token', `"${token}"`);
        } catch (_) {
          // Fallback: iframe trick
          const iframe = document.createElement('iframe');
          document.head.append(iframe);
          const pd = Object.getOwnPropertyDescriptor(iframe.contentWindow, 'localStorage');
          pd.get.call(iframe.contentWindow).setItem('token', `"${token}"`);
          iframe.remove();
        }
      }, DISCORD_TOKEN);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(5000);

      // Verify it actually logged in
      if (!page.url().includes('login') && !page.url().includes('register')) {
        log('✅', 'Discord token injection succeeded');
        return;
      }
      log('⚠️', 'Token injection did not log in — falling through to email/password');
    } catch (err) {
      log('⚠️', 'Token injection error:', err.message, '— trying email/password');
    }
  }

  // Try 2: Email + password (most reliable)
  if (DISCORD_EMAIL && DISCORD_PASSWORD) {
    log('🔑', 'Logging in with email + password...');
    try {
      if (!page.url().includes('login')) {
        await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }
      await page.waitForSelector('input[name="email"]', { timeout: 15000 });
      await page.fill('input[name="email"]', DISCORD_EMAIL);
      await sleep(400);
      await page.fill('input[name="password"]', DISCORD_PASSWORD);
      await sleep(400);
      await page.click('button[type="submit"]');
      await sleep(6000);

      // Handle 2FA prompt if present
      const twoFaInput = await page.$('input[name="code"], input[placeholder*="6-digit"], input[placeholder*="digit"]');
      if (twoFaInput) {
        log('⚠️', '2FA required — cannot log in automatically. Disable 2FA on this account or log in manually via noVNC.');
        return;
      }

      if (!page.url().includes('login')) {
        log('✅', 'Discord email/password login succeeded');
      } else {
        log('❌', 'Discord login failed — wrong credentials or rate-limited. Check DISCORD_EMAIL / DISCORD_PASSWORD');
      }
    } catch (err) {
      log('❌', 'Discord email login error:', err.message);
    }
    return;
  }

  log('❌', 'No Discord auth worked — set DISCORD_TOKEN, DISCORD_COOKIES, or DISCORD_EMAIL+DISCORD_PASSWORD');
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE CHANNEL — navigate browser to a specific guild+channel
// ─────────────────────────────────────────────────────────────────────────────
async function joinVoiceChannelById(guildId, channelId) {
  if (!discordPage) { log('❌', 'Discord tab not open'); return false; }
  log('🔊', `Navigating to channel ${channelId} in guild ${guildId}`);
  try {
    await discordPage.goto(
      `https://discord.com/channels/${guildId}/${channelId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await sleep(2000);

    // Click "Join Voice" if the prompt appears
    const joinBtn = discordPage.locator('button:has-text("Join Voice"), button:has-text("Join")');
    if (await joinBtn.count() > 0) {
      await joinBtn.first().click();
      await sleep(1500);
    }

    // Grant mic permission if asked
    const allowBtn = discordPage.locator('button:has-text("Allow"), button:has-text("Grant Access")');
    if (await allowBtn.count() > 0) await allowBtn.first().click();

    log('✅', `Milo joined voice channel ${channelId}`);
    return true;
  } catch (err) {
    log('❌', 'joinVoiceChannelById error:', err.message);
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
    // Fallback keyboard shortcut
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
//  AUTO-START
// ─────────────────────────────────────────────────────────────────────────────
async function autoStart() {
  log('🚀', 'Auto-starting browser session...');
  try {
    const ctx = await launchBrowser();

    if (hasGrokAuth) await openGrokTab(ctx);
    else log('⚠️', 'Skipping Grok tab (no GROK_COOKIES)');

    await openDiscordTab(ctx);

    log('🎉', '══════════════════════════════════════════════');
    log('🎉', `  ${PERSONA.name} is LIVE!`);
    log('🎉', '  Tag @Milo in chat or join a VC and she follows');
    log('🎉', '  noVNC → http://YOUR_HOST:6080/vnc.html?autoconnect=true&resize=scale');
    log('🎉', '══════════════════════════════════════════════');
  } catch (err) {
    log('❌', 'Auto-start failed:', err.message);
    log('🔄', 'Retrying in 15s...');
    setTimeout(autoStart, 15000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD BOT (slash commands + voice tracker + tag handler)
// ─────────────────────────────────────────────────────────────────────────────
async function startDiscordBot() {
  if (!DISCORD_TOKEN) {
    log('ℹ️', 'No DISCORD_TOKEN — slash commands + voice tracking unavailable');
    return;
  }

  const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,   // required to track owner's VC movements
    ],
  });

  const commands = [
    { name: 'restart', description: '🔄 Restart the browser session' },
    { name: 'stop',    description: '🛑 Stop the browser session' },
    { name: 'ask',     description: '💬 Ask Grok something via voice' },
    { name: 'reset',   description: '🔄 Reset Milo\'s conversation memory' },
    { name: 'status',  description: '📊 Check Milo\'s status' },
  ];

  client.once('ready', async () => {
    log('✅', `Control bot logged in as ${client.user.tag}`);
    await client.application.commands.set(commands);
    log('✅', 'Slash commands registered');
    log('👑', `Owner ID: ${OWNER_ID} | Milo account ID: ${MILO_ACCOUNT_ID}`);
  });

  // ── VOICE STATE TRACKER — Milo follows the owner ───────────────────────────
  client.on('voiceStateUpdate', async (oldState, newState) => {
    // Only follow the owner
    if (newState.member?.id !== OWNER_ID) return;

    const newChannel = newState.channel;
    const oldChannel = oldState.channel;

    if (newChannel && newChannel.id !== oldChannel?.id) {
      log('🔊', `Owner joined #${newChannel.name} — Milo following...`);
      await joinVoiceChannelById(newChannel.guild.id, newChannel.id);
    } else if (!newChannel && oldChannel) {
      log('🔇', 'Owner left VC — Milo stays put');
    }
  });

  // ── MESSAGE HANDLER — only react when owner tags Milo ─────────────────────
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // Hard gate: only the owner can trigger Milo
    if (message.author.id !== OWNER_ID) return;

    const raw = message.content.trim();
    if (!raw) return;

    // Must tag Milo (@Milo, <@MILO_ACCOUNT_ID>, etc.)
    if (!isMiloTagged(raw)) return;

    const text = stripMiloTag(raw);
    log('📩', `Owner tagged Milo with: "${text || '(empty)'}"`);

    // ── "join vc" or bare tag → join owner's current VC ───────────────────
    if (isJoinVcIntent(text)) {
      const ownerMember = await message.guild.members.fetch(OWNER_ID).catch(() => null);
      const vcChannel   = ownerMember?.voice?.channel;

      if (vcChannel) {
        await message.react('🔊');
        const ok = await joinVoiceChannelById(message.guild.id, vcChannel.id);
        if (!ok) {
          await message.reactions.cache.get('🔊')?.remove().catch(() => {});
          await message.react('❌');
        }
      } else {
        await message.reply("you're not in a VC right now 👀 join one first and tag me again");
      }
      return;
    }

    // ── Everything else → DeepSeek replies as Milo ────────────────────────
    try {
      await message.channel.sendTyping();
      const reply = await chatWithDeepSeek(text, message.channel.id, message.author.username);
      await message.reply(reply);
    } catch (err) {
      log('❌', 'DeepSeek reply error:', err);
      await message.react('❌');
    }
  });

  // ── SLASH COMMANDS (owner-only) ────────────────────────────────────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== OWNER_ID)
      return interaction.reply({ content: '🚫 Not your bot.', flags: MessageFlags.Ephemeral });

    const cmd = interaction.commandName;

    if (cmd === 'restart') {
      await interaction.reply('🔄 Restarting...');
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
        components: [{
          type: 1, components: [{
            type: 4, customId: 'askText', label: 'Your question',
            style: 2, placeholder: 'Ask Grok anything...', required: true, maxLength: 500,
          }],
        }],
      });
    }

    if (cmd === 'reset') {
      resetConversation(interaction.channel.id);
      await interaction.reply({ content: `🔄 ${PERSONA.name}'s memory wiped — fresh start!`, flags: MessageFlags.Ephemeral });
    }

    if (cmd === 'status') {
      const uptime = process.uptime();
      const hh = Math.floor(uptime / 3600);
      const mm = Math.floor((uptime % 3600) / 60);
      const ss = Math.floor(uptime % 60);
      const lines = [
        `🤖 **${PERSONA.name}** — ${browser ? '🟢 Running' : '🔴 Stopped'}`,
        `🌐 Browser  : ${browser     ? '✅ Open' : '❌ Closed'}`,
        `🎙️ Grok tab : ${grokPage    ? '✅ Open' : '❌ Closed'}`,
        `💬 Discord  : ${discordPage ? '✅ Open' : '❌ Closed'}`,
        `🧠 DeepSeek : ${DEEPSEEK_API_KEY ? '✅ Enabled' : '❌ Disabled'}`,
        `👑 Owner    : ${OWNER_ID}`,
        `⏱️ Uptime   : ${hh}h ${mm}m ${ss}s`,
      ];
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
  });

  // ── MODAL SUBMISSIONS ──────────────────────────────────────────────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId === 'askModal') {
      const text = interaction.fields.getTextInputValue('askText');
      await interaction.reply('⏳ Sending to Grok...');
      const ok = await sendToGrok(text);
      await interaction.editReply(ok ? '🔊 Grok is responding!' : '❌ Failed to reach Grok.');
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
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('🚀', `Booting ${PERSONA.name}...`);
  const botPromise = startDiscordBot().catch(err => log('❌', 'Discord bot error:', err));
  await autoStart();
  await botPromise;
}

main();
