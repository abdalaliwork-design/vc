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
// ─────────────────────────────────────────────────────────────────────────────
let browser       = null;
let browserCtx    = null;
let grokPage      = null;   // LAZY — only opened on /ask, auto-closes after idle
let discordPage   = null;
let isBusy        = false;
let grokIdleTimer = null;
const conversationHistory = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(emoji, ...args) { console.log(new Date().toISOString(), emoji, ...args); }

// ─────────────────────────────────────────────────────────────────────────────
//  RESOURCE BLOCKING
//  Blocks images, media, fonts, and tracking scripts on all pages.
//  Discord and Grok work fine without them. Saves ~200-400MB per tab.
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
//  BROWSER LAUNCH
// ─────────────────────────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser) {
    try { browser.contexts(); }
    catch (_) { cleanupBrowser(); }
  }
  if (browser) return browserCtx;
  log('🌐', 'Launching browser...');

  browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',

      // ── DO NOT add --disable-dev-shm-usage ───────────────────────────────
      // shm_size=4gb is set in docker-compose. Discord voice needs shared mem.

      '--disable-blink-features=AutomationControlled',

      // ── GPU: swiftshader (software GL that WebRTC still accepts) ──────────
      // DO NOT use --disable-gpu + --disable-software-rasterizer together —
      // that kills WebRTC's media pipeline and causes the Aw Snap crash.
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      '--ignore-gpu-blocklist',

      // ── Media ─────────────────────────────────────────────────────────────
      // DO NOT add --use-fake-ui-for-media-stream:
      //   it replaces your PulseAudio VirtualMic with a silent fake device,
      //   causing Discord Error 3002. Mic permissions are granted via context.
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',

      // ── Memory ────────────────────────────────────────────────────────────
      '--js-flags=--max-old-space-size=2048',
      '--memory-pressure-off',
      '--disable-component-update',

      // ── Reduce unnecessary processes ──────────────────────────────────────
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

      '--window-size=1920,1080',
      '--start-maximized',
    ],
    executablePath: CHROMIUM_PATH,
  });

  browserCtx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    // Grant mic/camera at context level — no dialog popup.
    // The actual audio device used will be PulseAudio's default (VirtualMic)
    // because we did NOT use --use-fake-ui-for-media-stream.
    permissions: ['microphone', 'camera', 'notifications', 'clipboard-read'],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  await browserCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3] });
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = p =>
      ['microphone', 'camera', 'notifications', 'clipboard-read'].includes(p?.name)
        ? Promise.resolve({ state: 'granted', onchange: null })
        : orig(p);
  });

  log('✅', 'Browser launched');
  return browserCtx;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GROK TAB — LAZY
//  Not opened on startup. Only opens when /ask is used.
//  Auto-closes after 5 minutes idle to free memory for Discord voice.
// ─────────────────────────────────────────────────────────────────────────────
const GROK_IDLE_MS = 5 * 60 * 1000;

async function ensureGrokTab() {
  if (!hasGrokAuth) { log('⚠️', 'No GROK_COOKIES — cannot open Grok'); return false; }

  // Check if existing page is still alive
  if (grokPage) {
    try { await grokPage.title(); }
    catch (_) { grokPage = null; }
  }

  if (grokPage) { rescheduleGrokIdle(); return true; }

  const ctx = await launchBrowser();
  log('🤖', 'Opening Grok tab (lazy)...');
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
    log('✅', 'Grok tab ready');
    await activateGrokVoice();
    rescheduleGrokIdle();
    return true;
  } else {
    log('⚠️', 'Grok login failed — check GROK_COOKIES');
    await grokPage.close().catch(() => {});
    grokPage = null;
    return false;
  }
}

function rescheduleGrokIdle() {
  if (grokIdleTimer) clearTimeout(grokIdleTimer);
  grokIdleTimer = setTimeout(() => {
    log('💤', 'Closing Grok tab after inactivity (freeing memory for Discord voice)');
    if (grokPage) { grokPage.close().catch(() => {}); grokPage = null; }
    grokIdleTimer = null;
  }, GROK_IDLE_MS);
}

function closeGrokTab() {
  if (grokIdleTimer) { clearTimeout(grokIdleTimer); grokIdleTimer = null; }
  if (grokPage) { grokPage.close().catch(() => {}); grokPage = null; }
  log('🗑️', 'Grok tab closed');
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD TAB
// ─────────────────────────────────────────────────────────────────────────────
async function openDiscordTab(ctx) {
  log('💬', 'Opening Discord tab (Milo account)...');
  discordPage = await ctx.newPage();
  discordPage.on('dialog', d => d.dismiss().catch(() => {}));

  // Block images/media/fonts — Discord renders fine without them, saves ~200MB
  await blockHeavyResources(discordPage);

  discordPage.on('crash', () => {
    log('💥', 'Discord page crashed — recovering in 5s...');
    discordPage = null;
    setTimeout(async () => {
      const c = await launchBrowser().catch(() => null);
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
//  Opens Discord User Settings → Voice & Video and sets Input Device to Default.
//  "Default" maps to VirtualMic via PulseAudio (we set it as default source).
//  Called automatically 4 seconds after joining a voice channel.
// ─────────────────────────────────────────────────────────────────────────────
async function fixDiscordMicSettings() {
  if (!discordPage) return;
  log('🎤', 'Fixing Discord mic settings...');
  try {
    // Open User Settings
    const gearBtn = discordPage.locator('[aria-label="User Settings"]').first();
    if (await gearBtn.count() === 0) {
      log('⚠️', 'Settings gear not found — skipping mic fix'); return;
    }
    await gearBtn.click();
    await sleep(1500);

    // Click Voice & Video in the settings sidebar
    const voiceNav = discordPage.locator('[class*="item"]:has-text("Voice & Video")').first();
    if (await voiceNav.count() === 0) {
      await discordPage.keyboard.press('Escape');
      log('⚠️', 'Voice & Video setting not found — skipping mic fix'); return;
    }
    await voiceNav.click();
    await sleep(1000);

    // Set Input Device to Default (maps to VirtualMic via PulseAudio default source)
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
    // Step 1: Navigate to guild first if we're not already there (lighter than jumping to channel directly)
    const currentUrl = discordPage.url();
    if (!currentUrl.includes(guildId)) {
      await discordPage.goto(
        `https://discord.com/channels/${guildId}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
      await sleep(2000);
    }

    // Step 2: Try clicking the VC link in the sidebar (less aggressive than full page navigation)
    const vcLink = discordPage.locator(
      `a[href*="/${channelId}"], [data-list-item-id*="${channelId}"]`
    ).first();

    if (await vcLink.count() > 0) {
      log('🖱️', 'Clicking VC in sidebar...');
      await vcLink.click();
      await sleep(2000);
    } else {
      // Fallback: direct navigation
      log('🔗', 'VC not in sidebar — navigating directly...');
      await discordPage.goto(
        `https://discord.com/channels/${guildId}/${channelId}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
      await sleep(2000);
    }

    // Step 3: Click "Join Voice" if the button appears
    const joinBtn = discordPage.locator(
      'button:has-text("Join Voice"), button:has-text("Join")'
    ).first();
    if (await joinBtn.count() > 0) {
      await joinBtn.click();
      await sleep(2000);
    }

    // Step 4: Allow mic if browser shows a prompt
    const allowBtn = discordPage.locator('button:has-text("Allow"), button:has-text("Grant Access")').first();
    if (await allowBtn.count() > 0) await allowBtn.click();

    log('✅', `Milo joined VC ${channelId}`);

    // Step 5: Fix mic settings after Discord loads voice
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
//  SEND TO GROK (opens tab lazily if needed)
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
//  AUTO-START  (Discord tab only — Grok tab is lazy)
// ─────────────────────────────────────────────────────────────────────────────
async function autoStart() {
  log('🚀', 'Auto-starting browser session...');
  try {
    const ctx = await launchBrowser();

    // Only Discord tab on startup — Grok opens on first /ask.
    // This keeps memory free for Discord voice/WebRTC.
    await openDiscordTab(ctx);

    log('🎉', '══════════════════════════════════════════════');
    log('🎉', `  ${PERSONA.name} is LIVE!`);
    log('🎉', '  Tag @Milo in chat or join a VC and she follows');
    log('🎉', '  Grok tab is lazy — opens on first /ask, closes after 5min idle');
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

  const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
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
        content: '🗑️ Grok tab closed (memory freed). Will re-open on next /ask.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (cmd === 'status') {
      const uptime = process.uptime();
      const hh = Math.floor(uptime / 3600);
      const mm = Math.floor((uptime % 3600) / 60);
      const ss = Math.floor(uptime % 60);
      const lines = [
        `🤖 **${PERSONA.name}** — ${browser ? '🟢 Running' : '🔴 Stopped'}`,
        `🌐 Browser  : ${browser     ? '✅ Open' : '❌ Closed'}`,
        `🎙️ Grok tab : ${grokPage    ? '✅ Open (auto-closes in 5min idle)' : '💤 Closed (opens on /ask)'}`,
        `💬 Discord  : ${discordPage ? '✅ Open' : '❌ Closed'}`,
        `🧠 DeepSeek : ${DEEPSEEK_API_KEY ? '✅ Enabled' : '❌ Disabled'}`,
        `👑 Owner    : ${OWNER_ID}`,
        `⏱️ Uptime   : ${hh}h ${mm}m ${ss}s`,
      ];
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
  });

  // ── MODAL SUBMISSIONS ─────────────────────────────────────────────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId === 'askModal') {
      const text = interaction.fields.getTextInputValue('askText');
      await interaction.reply('⏳ Opening Grok and sending...');
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
  if (grokIdleTimer) { clearTimeout(grokIdleTimer); grokIdleTimer = null; }
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
