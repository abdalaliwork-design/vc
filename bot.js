const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    AudioPlayerStatus,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

chromium.use(stealth);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ─── متغيرات الحالة ────────────────────────────────────────────────────────
let browser = null;
let page = null;
let ffmpegOut = null;
let connection = null;
let player = null;
let grokPassthrough = null;

// ─── وظيفة: تشغيل صوت Grok إلى Discord ─────────────────────────────────────
function startGrokAudio() {
    if (ffmpegOut) ffmpegOut.kill('SIGKILL');

    // نستخدم FFmpeg لسحب الصوت من PulseAudio (الذي يسجله المتصفح)
    ffmpegOut = spawn('ffmpeg', [
        '-f', 'pulse',
        '-i', 'DiscordSink.monitor', // المصدر الافتراضي في Docker
        '-acodec', 'libopus',
        '-f', 'opus',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    if (!grokPassthrough || grokPassthrough.destroyed) {
        grokPassthrough = new PassThrough();
    }

    ffmpegOut.stdout.pipe(grokPassthrough);

    ffmpegOut.on('error', (err) => console.error('FFmpeg Out Error:', err));
    ffmpegOut.stderr.on('data', (data) => {
        if (data.toString().includes('error')) console.log('FFmpeg Status:', data.toString());
    });
}

function initPlayer() {
    player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    // إنشاء مورد الصوت
    const playResource = () => {
        if (!grokPassthrough || grokPassthrough.destroyed) return;
        const resource = createAudioResource(grokPassthrough, { inputType: StreamType.OggOpus });
        player.play(resource);
    };

    playResource();

    // معالجة الأخطاء ومنع الحلقة المفرغة
    player.on('error', error => {
        console.error('❌ Player Error:', error.message);
        if (error.message.includes('Premature close')) {
            // تنظيف المجرى التالف وإعادة التشغيل بعد ثانية واحدة
            player.stop();
            setTimeout(() => {
                console.log('🔄 Re-initializing stream...');
                startGrokAudio();
                playResource();
            }, 1000);
        }
    });

    player.on(AudioPlayerStatus.Idle, () => {
        console.log('⚠️ Player went Idle — reattaching resource');
        playResource();
    });
}

// ─── أوامر البوت ───────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'start') {
        await interaction.deferReply();
        
        try {
            const channel = interaction.member.voice.channel;
            if (!channel) return interaction.editReply('يجب أن تكون في قناة صوتية!');

            // 1. الاتصال بالقناة
            connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
            });

            // 2. تشغيل المتصفح (Grok)
            browser = await chromium.launch({ 
                headless: true, 
                args: ['--use-fake-ui-for-media-stream', '--no-sandbox'] 
            });
            page = await browser.newPage();
            await page.goto('https://x.com/i/grok'); // تعديل الرابط حسب الحاجة

            // 3. بدء تدفق الصوت
            startGrokAudio();
            initPlayer();
            connection.subscribe(player);

            await interaction.editReply('✅ تم بدء الجلسة وربط الصوت بنجاح!');

        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ حدث خطأ أثناء التشغيل.');
        }
    }

    if (interaction.commandName === 'stop') {
        cleanupAll();
        await interaction.reply('🛑 تم إيقاف الجلسة وتنظيف الموارد.');
    }
});

function cleanupAll() {
    if (ffmpegOut) ffmpegOut.kill('SIGKILL');
    if (grokPassthrough) grokPassthrough.destroy();
    if (player) player.stop();
    if (connection) connection.destroy();
    if (browser) browser.close();
}

client.login('YOUR_DISCORD_BOT_TOKEN');
