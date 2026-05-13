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
const MILO_TOKEN       = process.env.MILO_TOKEN       || null;
const GROK_COOKIES     = process.env.GROK_COOKIES     || null;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || null;
const GROK_URL         = 'https://grok.com';
const CHROMIUM_PATH    = process.env.CHROMIUM_PATH    || undefined;

const MILO_ACCOUNT_ID  = process.env.MILO_ACCOUNT_ID  || '1504162446196080754';
const OWNER_ID         = process.env.OWNER_ID         || '712321588342816879';

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
if (!hasGrokAuth)      console.warn('⚠️  GROK_COOKIES not set — Grok voice will be unavailable');
if (!DEEPSEEK_API_KEY) console.warn('⚠️  DEEPSEEK_API_KEY not set — text replies disabled');

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
//  Discord and Grok now run in SEPARATE browser instances:
//    discordBrowser  → headed  (visible in noVNC, needs WebRTC + shared mem)
//    grokBrowser     → headless (no display, saves ~500MB RAM + GPU pressure)
// ─────────────────────────────────────────────────────────────────────────────
let discordBrowser    = null;
let discordBrowserCtx = null;
let discordPage       = null;

let grokBrowser       = null;
let grokBrowserCtx    = null;
let grokPage          = null;

let isBusy        = false;
let grokIdleTimer = null;
const conversationHistory = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(emoji, ...args) { console.log(new Date().toISOString(), emoji, ...args); }

// ─────────────────────────────────────────────────────────────────────────────
//  RESOURCE BLOCKING
// ─────────────────────────────────────────────────────────────────────────────
const BLOCKED_TYPES = new Set(['image', 'media', 'font', 'ping']);
const BLOCKED_HOSTS = [
  'analytics', 'telemetry', 'tracking', 'metrics',
  'doubleclick', 'googlesyndication', 'adservice',
  'sentry.io', 'datadoghq', 'newrelic', 'fullstory',
  'hotjar', 'segment.io', 'mixpanel', 'amplitude',
  'clarity.ms', 'mouseflow', 'logrocket',
];

async function blockHeavyResources(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (BLOCKED_TYPES.has(type)) return route.abort();
    if (BLOCKED_HOSTS.some(h => url.includes(h))) return route.abort();
    route.continue();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAG HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function isMiloTagged(content) {
  return (
    content.includes(`<@${MILO_ACCOUNT_ID}>`)  ||
    content.includes(`<@!${MILO_ACCOUNT_ID}>`) ||
    content.toLowerCase().includes(`@${PERSONA.name.toLowerCase()}`)
  );
}

function stripMiloTag(content) {
  return content
    .replace(new RegExp(`<@!?${MILO_ACCOUNT_ID}>`, 'g'), '')
    .replace(new RegExp(`@${PERSONA.name}`, 'gi'), '')
    .trim();
}

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
        const cookie = {
          name:     c.name,
          value:    c.value,
          domain:   c.domain || domain,
          path:     c.path     || '/',
          secure:   c.secure   !== undefined ? c.secure   : true,
          httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
          sameSite: normalizeSameSite(c.sameSite),
        };
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
    return { name: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim(),
             domain, path: '/', secure: true, httpOnly: false, sameSite: 'None' };
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
  log('🔄', `Conversation reset for channel ${channelId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMMON BROWSER ARGS (shared baseline for both instances)
// ─────────────────────────────────────────────────────────────────────────────
const COMMON_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--disable-default-apps',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-ipc-flooding-protection',
  '--no-first-run',
  '--disable-hang-monitor',
  '--js-flags=--max-old-space-size=1536',
];

const COMMON_INIT_SCRIPT = () => {
  Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
  Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3] });
  const orig = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = p =>
    ['microphone', 'camera', 'notifications', 'clipboard-read'].includes(p?.name)
      ? Promise.resolve({ state: 'granted', onchange: null })
      : orig(p);
};

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD BROWSER — headed, full WebRTC + shared memory for voice
// ─────────────────────────────────────────────────────────────────────────────
async function launchDiscordBrowser() {
  if (discordBrowser) {
    try { discordBrowser.contexts(); return discordBrowserCtx; }
    catch (_) { cleanupDiscordBrowser(); }
  }

  log('🌐', 'Launching Discord browser (headed)...');
  discordBrowser = await chromium.launch({
    headless: false,
    executablePath: CHROMIUM_PATH,
    args: [
      ...COMMON_ARGS,
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      '--ignore-gpu-blocklist',
      // Audio: do NOT use --use-fake-ui-for-media-stream
      // PulseAudio VirtualMic is the real default source
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--memory-pressure-off',
      '--window-size=1920,1080',
      '--start-maximized',
    ],
  });

  discordBrowserCtx = await discordBrowser.newContext({
    viewport: { width: 1920, height: 1080 },
    permissions: ['microphone', 'camera', 'notifications', 'clipboard-read'],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  await discordBrowserCtx.addInitScript(COMMON_INIT_SCRIPT);

  log('✅', 'Discord browser launched (headed)');
  return discordBrowserCtx;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GROK BROWSER — headless, no GPU, lighter footprint
//  Audio still flows via PulseAudio at the OS level — headless doesn't block it.
//  Grok voice mode works because the browser connects to PulseAudio's default
//  sink (DiscordSink) regardless of headless/headed state.
// ─────────────────────────────────────────────────────────────────────────────
async function launchGrokBrowser() {
  if (grokBrowser) {
    try { grokBrowser.contexts(); return grokBrowserCtx; }
    catch (_) { cleanupGrokBrowser(); }
  }

  log('🤖', 'Launching Grok browser (headless)...');
  grokBrowser = await chromium.launch({
    headless: true,           // ← headless: saves GPU memory + no display contention
    executablePath: CHROMIUM_PATH,
    args: [
      ...COMMON_ARGS,
      '--disable-gpu',                        // safe in headless
      '--disable-software-rasterizer',        // safe — no rendering needed
      '--autoplay-policy=no-user-gesture-required',
      '--enable-usermedia-screen-capturing',  // still needed for mic/speaker
      // Audio output still routed to PulseAudio default sink (DiscordSink)
      '--alsa-output-device=pulse',
    ],
  });

  grokBrowserCtx = await grokBrowser.newContext({
    viewport: { width: 1280, height: 720 },   // smaller — nothing to display
    permissions: ['microphone', 'camera', 'notifications'],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  await grokBrowserCtx.addInitScript(COMMON_INIT_SCRIPT);

  log('✅', 'Grok browser launched (headless)');
  return grokBrowserCtx;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GROK TAB — LAZY + HEADLESS
// ─────────────────────────────────────────────────────────────────────────────
const GROK_IDLE_MS = 5 * 60 * 1000;

async function ensureGrokTab() {
  if (!hasGrokAuth) { log('⚠️', 'No GROK_COOKIES — cannot open Grok'); return false; }

  if (grokPage) {
    try { await grokPage.title(); }
    catch (_) { grokPage = null; }
  }

  if (grokPage) { rescheduleGrokIdle(); return true; }

  const ctx = await launchGrokBrowser();
  log('🤖', 'Opening Grok tab (headless, lazy)...');
  grokPage = await ctx.newPage();
  grokPage.on('dialog', d => d.dismiss().catch(() => {}));
  grokPage.on('crash', () => {
    log('💥', 'Grok page crashed — will re-open on next /ask');
    grokPage = null;
    if (grokIdleTimer) { clearTimeout(grokIdleTimer); grokIdleTimer = null; }
  });

  await blockHeavyResources(grokPage);

  const cookies = parseCookies(GROK_COOKIES, '.x.com');
  if (cookies.length) {
    await ctx.addCookies(cookies);
    log('🍪', `Injected ${cookies.length} Grok cookies`);
  }

  await grokPage.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  const isLoggedIn = !grokPage.url().includes('login') && !grokPage.url().includes('signin');
  if (isLoggedIn) {
    log('✅', 'Grok tab ready (headless)');
    await activateGrokVoice();
    rescheduleGrokIdle();
    return true;
  } else {
    log('⚠️', 'Grok login failed — check GROK_COOKIES');
    await grokPage.close().catch(() => {});
    grokPage = null;
    cleanupGrokBrowser();
    return false;
  }
}

function rescheduleGrokIdle() {
  if (grokIdleTimer) clearTimeout(grokIdleTimer);
  grokIdleTimer = setTimeout(() => {
    log('💤', 'Closing Grok tab + browser after inactivity');
    if (grokPage) { grokPage.close().catch(() => {}); grokPage = null; }
    cleanupGrokBrowser();
    grokIdleTimer = null;
  }, GROK_IDLE_MS);
}

function closeGrokTab() {
  if (grokIdleTimer) { clearTimeout(grokIdleTimer); grokIdleTimer = null; }
  if (grokPage) { grokPage.close().catch(() => {}); grokPage = null; }
  cleanupGrokBrowser();
  log('🗑️', 'Grok tab + browser closed');
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD TAB
// ─────────────────────────────────────────────────────────────────────────────
async function openDiscordTab(ctx) {
  log('💬', 'Opening Discord tab (Milo account)...');
  discordPage = await ctx.newPage();
  discordPage.on('dialog', d => d.dismiss().catch(() => {}));

  await blockHeavyResources(discordPage);

  discordPage.on('crash', () => {
    log('💥', 'Discord page crashed — recovering in 5s...');
    discordPage = null;
    setTimeout(async () => {
      const c = await launchDiscordBrowser().catch(() => null);
      if (c) openDiscordTab(c).catch(err => log('❌', 'Recovery failed:', err.message));
    }, 5000);
  });

  // ── Method 1: MILO_TOKEN ──────────────────────────────────────────────────
  if (MILO_TOKEN) {
    log('🔑', 'Injecting Milo user token...');
    await discordPage.addInitScript(token => {
      try { window.localStorage.setItem('token', JSON.stringify(token)); } catch (_) {}
    }, MILO_TOKEN);
    await discordPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    if (!discordPage.url().includes('login')) {
      log('✅', 'Discord logged in via MILO_TOKEN');
      await discordPage.waitForSelector('[class*="sidebar"], [class*="guilds"]', { timeout: 20000 }).catch(() => {});
      log('✅', 'Discord tab ready (Milo is online)');
      return;
    }
    log('⚠️', 'MILO_TOKEN may be expired — trying saved session');
  }

  // ── Method 2: Saved browser session ──────────────────────────────────────
  await discordPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  if (!discordPage.url().includes('login') && !discordPage.url().includes('register')) {
    log('✅', 'Discord logged in via saved session');
    await discordPage.waitForSelector('[class*="sidebar"], [class*="guilds"]', { timeout: 20000 }).catch(() => {});
    log('✅', 'Discord tab ready (Milo is online)');
    return;
  }

  // ── Method 3: Email + password ────────────────────────────────────────────
  if (DISCORD_EMAIL && DISCORD_PASSWORD) {
    log('🔑', 'Trying email/password login...');
    await loginToDiscordWeb(discordPage);
    await sleep(4000);
    if (!discordPage.url().includes('login')) {
      log('✅', 'Discord tab ready (Milo is online)');
      return;
    }
  }

  // ── Method 4: Manual login via noVNC ─────────────────────────────────────
  log('⚠️', '════════════════════════════════════════════════════════');
  log('⚠️', ' OPTION A — Get Milo\'s token from a logged-in browser:');
  log('⚠️', '   (webpackChunkdiscord_app.push([[\'\'  ],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m)');
  log('⚠️', '   .find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()');
  log('⚠️', '   Add as MILO_TOKEN env var.');
  log('⚠️', ' OPTION B — Log in manually via noVNC, waiting 5 minutes...');
  log('⚠️', '════════════════════════════════════════════════════════');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    if (!discordPage.url().includes('login') && !discordPage.url().includes('register')) {
      log('✅', 'Manual Discord login detected!');
      try {
        const savedToken = await discordPage.evaluate(() => {
          return (webpackChunkdiscord_app
            ?.flatMap(c => Object.values(c[1] || {}))
            ?.find(m => m?.exports?.default?.getToken)
            ?.exports?.default?.getToken()) || null;
        });
        if (savedToken) log('💾', `Save this as MILO_TOKEN:\n  ${savedToken}`);
      } catch (_) {}
      break;
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    if (remaining % 30 === 0) log('⏳', `Waiting for manual login... ${remaining}s left`);
  }

  const appReady = await discordPage.waitForSelector(
    '[class*="sidebar"], [class*="guilds"]', { timeout: 10000 }
  ).catch(() => null);

  if (appReady) log('✅', 'Discord tab ready (Milo is online)');
  else log('❌', 'Discord login failed — running without browser tab');
}

async function loginToDiscordWeb(page) {
  if (DISCORD_TOKEN) {
    log('🔑', 'Trying Discord token injection...');
    try {
      await page.evaluate(token => {
        try { window.localStorage.setItem('token', `"${token}"`); }
        catch (_) {
          const iframe = document.createElement('iframe');
          document.head.append(iframe);
          const pd = Object.getOwnPropertyDescriptor(iframe.contentWindow, 'localStorage');
          pd.get.call(iframe.contentWindow).setItem('token', `"${token}"`);
          iframe.remove();
        }
      }, DISCORD_TOKEN);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(5000);
      if (!page.url().includes('login') && !page.url().includes('register')) {
        log('✅', 'Discord token injection succeeded'); return;
      }
      log('⚠️', 'Token injection failed — trying email/password');
    } catch (err) { log('⚠️', 'Token injection error:', err.message); }
  }

  if (DISCORD_EMAIL && DISCORD_PASSWORD) {
    log('🔑', 'Logging in with email + password...');
    try {
      if (!page.url().includes('login'))
        await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      await page.waitForSelector('input[name="email"]', { timeout: 15000 });
      await page.fill('input[name="email"]', DISCORD_EMAIL);
      await sleep(400);
      await page.fill('input[name="password"]', DISCORD_PASSWORD);
      await sleep(400);
      await page.click('button[type="submit"]');
      await sleep(6000);
      const twoFaInput = await page.$('input[name="code"], input[placeholder*="6-digit"]');
      if (twoFaInput) { log('⚠️', '2FA required — disable 2FA or log in manually via noVNC'); return; }
      if (!page.url().includes('login')) log('✅', 'Email/password login succeeded');
      else log('❌', 'Login failed — wrong credentials or rate-limited');
    } catch (err) { log('❌', 'Email login error:', err.message); }
    return;
  }

  log('❌', 'No Discord auth method worked');
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD MIC SETTINGS FIX
// ─────────────────────────────────────────────────────────────────────────────
async function fixDiscordMicSettings() {
  if (!discordPage) return;
  log('🎤', 'Fixing Discord mic settings...');
  try {
    const gearBtn = discordPage.locator('[aria-label="User Settings"]').first();
    if (await gearBtn.count() === 0) {
      log('⚠️', 'Settings gear not found — skipping mic fix'); return;
    }
    await gearBtn.click();
    await sleep(1500);

    const voiceNav = discordPage.locator('[class*="item"]:has-text("Voice & Video")').first();
    if (await voiceNav.count() === 0) {
      await discordPage.keyboard.press('Escape');
      log('⚠️', 'Voice & Video setting not found — skipping mic fix'); return;
    }
    await voiceNav.click();
    await sleep(1000);

    const inputWrapper = discordPage.locator(
      '[class*="deviceSelectWrapper"], [class*="inputDevice"], [class*="inputDevices"]'
    ).first();
    if (await inputWrapper.count() > 0) {
      await inputWrapper.click();
      await sleep(500);
      const defaultOpt = discordPage.locator('[class*="option"]:has-text("Default")').first();
      if (await defaultOpt.count() > 0) {
        await defaultOpt.click();
        log('✅', 'Mic input set to Default (→ VirtualMic via PulseAudio)');
      }
    } else {
      log('⚠️', 'Input device dropdown not found — Discord may auto-select VirtualMic');
    }

    await discordPage.keyboard.press('Escape');
    await sleep(500);
  } catch (err) {
    log('⚠️', 'fixDiscordMicSettings (non-fatal):', err.message);
    try { await discordPage.keyboard.press('Escape'); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE CHANNEL JOIN
// ─────────────────────────────────────────────────────────────────────────────
async function joinVoiceChannelById(guildId, channelId) {
  if (!discordPage) { log('❌', 'Discord tab not open'); return false; }
  log('🔊', `Joining VC ${channelId} in guild ${guildId}`);
  try {
    const currentUrl = discordPage.url();
    if (!currentUrl.includes(guildId)) {
      await discordPage.goto(
        `https://discord.com/channels/${guildId}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
      await sleep(2000);
    }

    const vcLink = discordPage.locator(
      `a[href*="/${channelId}"], [data-list-item-id*="${channelId}"]`
    ).first();

    if (await vcLink.count() > 0) {
      log('🖱️', 'Clicking VC in sidebar...');
      await vcLink.click();
      await sleep(2000);
    } else {
      log('🔗', 'VC not in sidebar — navigating directly...');
      await discordPage.goto(
        `https://discord.com/channels/${guildId}/${channelId}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
      await sleep(2000);
    }

    const joinBtn = discordPage.locator(
      'button:has-text("Join Voice"), button:has-text("Join")'
    ).first();
    if (await joinBtn.count() > 0) {
      await joinBtn.click();
      await sleep(2000);
    }

    const allowBtn = discordPage.locator('button:has-text("Allow"), button:has-text("Grant Access")').first();
    if (await allowBtn.count() > 0) await allowBtn.click();

    log('✅', `Milo joined VC ${channelId}`);
    setTimeout(() => fixDiscordMicSettings().catch(() => {}), 4000);
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
  if (isBusy) return false;
  isBusy = true;
  log('📨', `Sending to Grok: "${text}"`);
  try {
    const ready = await ensureGrokTab();
    if (!ready) { log('❌', 'Grok tab unavailable'); return false; }

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
    rescheduleGrokIdle();
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
//  SCREENSHOT GROK  (headless → Buffer → Discord attachment)
// ─────────────────────────────────────────────────────────────────────────────
async function screenshotGrok() {
  log('📸', 'Taking Grok screenshot...');
  try {
    const ready = await ensureGrokTab();
    if (!ready) return { ok: false, error: 'Grok tab unavailable — check GROK_COOKIES' };

    // Wait briefly for any in-progress render to settle
    await sleep(800);

    const buf = await grokPage.screenshot({
      type:     'png',
      fullPage: false,      // viewport only — keeps file small
      animations: 'disabled',
    });

    rescheduleGrokIdle();
    log('✅', `Screenshot taken (${(buf.length / 1024).toFixed(0)} KB)`);
    return { ok: true, buf };
  } catch (err) {
    log('❌', 'screenshotGrok error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-START  (Discord only on boot — Grok is lazy)
// ─────────────────────────────────────────────────────────────────────────────
async function autoStart() {
  log('🚀', 'Auto-starting browser session...');
  try {
    const ctx = await launchDiscordBrowser();
    await openDiscordTab(ctx);

    log('🎉', '══════════════════════════════════════════════');
    log('🎉', `  ${PERSONA.name} is LIVE!`);
    log('🎉', '  Tag @Milo in chat or join a VC and she follows');
    log('🎉', '  Grok → headless browser, opens on first /ask, closes after 5min idle');
    log('🎉', '  noVNC → http://YOUR_HOST:6080/vnc.html?autoconnect=true&resize=scale');
    log('🎉', '══════════════════════════════════════════════');
  } catch (err) {
    log('❌', 'Auto-start failed:', err.message);
    log('🔄', 'Retrying in 15s...');
    setTimeout(autoStart, 15000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD BOT
// ─────────────────────────────────────────────────────────────────────────────
async function startDiscordBot() {
  if (!DISCORD_TOKEN) {
    log('ℹ️', 'No DISCORD_TOKEN — slash commands + voice tracking unavailable');
    return;
  }

  const { Client, GatewayIntentBits, MessageFlags, AttachmentBuilder } = require('discord.js');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  const commands = [
    { name: 'restart',   description: '🔄 Restart the browser session' },
    { name: 'stop',      description: '🛑 Stop the browser session' },
    { name: 'ask',       description: '💬 Ask Grok something via voice' },
    { name: 'reset',     description: '🔄 Reset Milo\'s conversation memory' },
    { name: 'status',    description: '📊 Check Milo\'s status' },
    { name: 'closegrok', description: '🗑️ Close Grok tab to free memory' },
    { name: 'view',      description: '📸 Screenshot the Grok tab and send it here' },
  ];

  client.once('ready', async () => {
    log('✅', `Control bot logged in as ${client.user.tag}`);
    await client.application.commands.set(commands);
    log('✅', 'Slash commands registered');
    log('👑', `Owner ID: ${OWNER_ID} | Milo account ID: ${MILO_ACCOUNT_ID}`);
  });

  // ── VOICE STATE TRACKER ───────────────────────────────────────────────────
  client.on('voiceStateUpdate', async (oldState, newState) => {
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

  // ── MESSAGE HANDLER ───────────────────────────────────────────────────────
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.author.id !== OWNER_ID) return;
    const raw = message.content.trim();
    if (!raw || !isMiloTagged(raw)) return;

    const text = stripMiloTag(raw);
    log('📩', `Owner tagged Milo with: "${text || '(empty)'}"`);

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

    try {
      await message.channel.sendTyping();
      const reply = await chatWithDeepSeek(text, message.channel.id, message.author.username);
      await message.reply(reply);
    } catch (err) {
      log('❌', 'DeepSeek reply error:', err);
      await message.react('❌');
    }
  });

  // ── SLASH COMMANDS ────────────────────────────────────────────────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== OWNER_ID)
      return interaction.reply({ content: '🚫 Not your bot.', flags: MessageFlags.Ephemeral });

    const cmd = interaction.commandName;

    if (cmd === 'restart') {
      await interaction.reply('🔄 Restarting...');
      cleanupAll();
      await sleep(2000);
      try {
        await autoStart();
        await interaction.editReply('✅ Session restarted!');
      } catch (err) {
        await interaction.editReply('❌ Restart failed: ' + err.message);
      }
    }

    if (cmd === 'stop') {
      if (!discordBrowser && !grokBrowser)
        return interaction.reply({ content: '⚠️ Nothing running.', flags: MessageFlags.Ephemeral });
      await interaction.reply('🛑 Shutting down...');
      cleanupAll();
      await interaction.editReply('✅ Stopped.');
    }

    if (cmd === 'ask') {
      if (!hasGrokAuth)
        return interaction.reply({ content: '❌ GROK_COOKIES not set', flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: `🔄 ${PERSONA.name}'s memory wiped!`, flags: MessageFlags.Ephemeral });
    }

    if (cmd === 'closegrok') {
      closeGrokTab();
      await interaction.reply({
        content: '🗑️ Grok tab + browser closed (memory freed). Will re-open on next /ask.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (cmd === 'view') {
      if (!hasGrokAuth)
        return interaction.reply({ content: '❌ GROK_COOKIES not set — Grok tab unavailable', flags: MessageFlags.Ephemeral });

      await interaction.deferReply();           // gives us 15 min instead of 3s
      const { ok, buf, error } = await screenshotGrok();

      if (!ok) {
        return interaction.editReply(`❌ Screenshot failed: ${error}`);
      }

      const attachment = new AttachmentBuilder(buf, { name: 'grok.png' });
      const url = grokPage ? grokPage.url() : GROK_URL;
      await interaction.editReply({
        content: `📸 **Grok** — \`${url}\``,
        files: [attachment],
      });
    }

    if (cmd === 'status') {
      const uptime = process.uptime();
      const hh = Math.floor(uptime / 3600);
      const mm = Math.floor((uptime % 3600) / 60);
      const ss = Math.floor(uptime % 60);
      const lines = [
        `🤖 **${PERSONA.name}** — ${discordBrowser ? '🟢 Running' : '🔴 Stopped'}`,
        `🌐 Discord browser : ${discordBrowser ? '✅ Headed (visible in noVNC)' : '❌ Closed'}`,
        `🤖 Grok browser    : ${grokBrowser    ? '✅ Headless (active)' : '💤 Closed (opens on /ask)'}`,
        `🎙️ Grok tab        : ${grokPage       ? '✅ Open' : '💤 Closed (auto-closes after 5min idle)'}`,
        `💬 Discord tab     : ${discordPage    ? '✅ Open' : '❌ Closed'}`,
        `🧠 DeepSeek        : ${DEEPSEEK_API_KEY ? '✅ Enabled' : '❌ Disabled'}`,
        `👑 Owner           : ${OWNER_ID}`,
        `⏱️ Uptime          : ${hh}h ${mm}m ${ss}s`,
      ];
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
  });

  // ── MODAL SUBMISSIONS ─────────────────────────────────────────────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId === 'askModal') {
      const text = interaction.fields.getTextInputValue('askText');
      await interaction.reply('⏳ Opening Grok (headless) and sending...');
      const ok = await sendToGrok(text);
      await interaction.editReply(ok ? '🔊 Grok is responding!' : '❌ Failed to reach Grok.');
    }
  });

  await client.login(DISCORD_TOKEN);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLEANUP
// ─────────────────────────────────────────────────────────────────────────────
function cleanupDiscordBrowser() {
  if (discordBrowser) { discordBrowser.close().catch(() => {}); discordBrowser = null; }
  discordBrowserCtx = null;
  discordPage       = null;
  log('🧹', 'Discord browser cleaned up');
}

function cleanupGrokBrowser() {
  if (grokBrowser) { grokBrowser.close().catch(() => {}); grokBrowser = null; }
  grokBrowserCtx = null;
  grokPage       = null;
  log('🧹', 'Grok browser cleaned up');
}

function cleanupAll() {
  isBusy = false;
  if (grokIdleTimer) { clearTimeout(grokIdleTimer); grokIdleTimer = null; }
  cleanupDiscordBrowser();
  cleanupGrokBrowser();
  log('🧹', 'All browser resources cleaned up');
}

process.on('SIGINT',  () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
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
