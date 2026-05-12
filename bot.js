const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const fs = require('fs');
const prism = require('prism-media');

// تفعيل إضافة التخفي للمتصفح
chromium.use(stealth);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// متغيرات عامة لإدارة الجلسة
let browser = null;
let page = null;
let ffmpegProcessOut = null; // لإرسال صوت Grok إلى Discord
let ffmpegProcessIn = null;  // لإرسال صوتك إلى Grok
let connection = null;
let player = null;

// تعريف أوامر السلاش (Slash Commands)
const commands = [
    {
        name: 'start',
        description: 'يبدأ تشغيل متصفح Grok وبث الصوت إلى القناة الصوتية 🎙️',
    },
    {
        name: 'stop',
        description: 'يوقف الجلسة ويغلق المتصفح لتوفير الموارد 🛑',
    }
];

client.on('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);

    // تسجيل الأوامر في ديسكورد لتظهر في القائمة
    try {
        console.log('🔄 جاري تسجيل أوامر السلاش (Slash Commands)...');
        await client.application.commands.set(commands);
        console.log('✅ تم تسجيل الأوامر بنجاح! ستظهر في ديسكورد الآن.');
    } catch (error) {
        console.error('❌ خطأ في تسجيل الأوامر:', error);
    }
});

// التعامل مع أوامر السلاش عند الضغط عليها
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // --- أمر البدء ---
    if (interaction.commandName === 'start') {
        const voiceChannel = interaction.member?.voice.channel;
        
        // التحقق من وجود المستخدم في قناة صوتية (يظهر الخطأ له فقط)
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ يجب أن تكون في قناة صوتية أولاً!', ephemeral: true });
        }
        if (browser) {
            return interaction.reply({ content: '⚠️ جلسة Grok تعمل بالفعل!', ephemeral: true });
        }

        // الرد الأولي (لأن ديسكورد يتطلب رداً خلال 3 ثوانٍ)
        await interaction.reply('🔄 جاري بدء محرك الاستخراج وتهيئة المتصفح...');

        try {
            // 1. الاتصال بالقناة الصوتية لديسكورد
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false, // 🔴 مهم جداً: عدم كتم السماعات لاستقبال صوتك
                selfMute: false
            });

            // 2. تشغيل المتصفح (Headless: false) داخل شاشة Xvfb الوهمية لضمان عمل الصوت
            browser = await chromium.launch({
                headless: false, 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--autoplay-policy=no-user-gesture-required',
                    '--use-fake-ui-for-media-stream', // 🔴 السماح للمتصفح باستخدام الميكروفون دون طلب إذن
                    '--use-fake-device-for-media-stream'
                ]
            });

            const context = await browser.newContext({
                permissions: ['microphone'] // 🔴 منح صلاحية الميكروفون للمتصفح
            });

            // 3. حقن الكوكيز الخاصة بتسجيل الدخول (من Railway Variables أو الملف)
            let cookies = null;

            // دالة لتحويل كوكيز Chrome إلى صيغة Playwright
            const convertCookies = (rawCookies) => {
                return rawCookies.map(cookie => {
                    // تحويل sameSite من صيغة Chrome إلى صيغة Playwright
                    let sameSite = 'Lax'; // القيمة الافتراضية
                    
                    if (cookie.sameSite) {
                        const sameSiteLower = cookie.sameSite.toLowerCase();
                        if (sameSiteLower === 'strict') sameSite = 'Strict';
                        else if (sameSiteLower === 'lax') sameSite = 'Lax';
                        else if (sameSiteLower === 'none' || sameSiteLower === 'no_restriction') sameSite = 'None';
                        else sameSite = 'Lax'; // unspecified → Lax
                    }

                    // تحويل expirationDate (timestamp) إلى expires (Unix timestamp)
                    const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : -1;

                    return {
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path || '/',
                        expires: expires,
                        httpOnly: cookie.httpOnly || false,
                        secure: cookie.secure || false,
                        sameSite: sameSite
                    };
                });
            };

            if (process.env.GROK_COOKIES) {
                try {
                    const rawCookies = JSON.parse(process.env.GROK_COOKIES);
                    cookies = convertCookies(rawCookies);
                    console.log('✅ تم جلب وتحويل الكوكيز من متغيرات Railway بنجاح.');
                } catch (err) {
                    console.error('❌ خطأ في تحليل JSON الخاص بالكوكيز من المتغيرات!', err);
                    interaction.channel.send('⚠️ خطأ في قراءة متغير GROK_COOKIES، تأكد من صحة الكود المنسوخ.');
                }
            } else if (fs.existsSync('./cookies.json')) {
                const rawCookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
                cookies = convertCookies(rawCookies);
                console.log('✅ تم جلب وتحويل الكوكيز من ملف cookies.json المحلي.');
            }

            if (cookies) {
                await context.addCookies(cookies);
            } else {
                interaction.channel.send('⚠️ تنبيه: لم يتم العثور على كوكيز (لا في Railway ولا في الملف). قد يُطلب تسجيل الدخول يدوياً.');
            }

            // ضمان فتح Tab واحد فقط لتوفير استهلاك الرام (< 1GB)
            page = await context.newPage();
            await page.goto('https://grok.com', { waitUntil: 'networkidle' });

            // 4. ربط صوت Discord بالمتصفح (لإرسال صوتك إلى Grok)
            const receiver = connection.receiver;
            
            connection.on(VoiceConnectionStatus.Ready, () => {
                console.log('✅ اتصال الصوت جاهز!');
                
                // الاستماع لصوت المستخدم الذي استدعى الأمر
                const audioStream = receiver.subscribe(interaction.user.id, {
                    end: {
                        behavior: EndBehaviorType.AfterSilence,
                        duration: 100
                    }
                });

                // تحويل Opus إلى PCM
                const opusDecoder = new prism.opus.Decoder({
                    rate: 48000,
                    channels: 2,
                    frameSize: 960
                });

                // 🔴 إرسال صوتك إلى DiscordMic (ليسمعه Grok)
                ffmpegProcessIn = spawn('ffmpeg', [
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-i', 'pipe:0',
                    '-f', 'pulse',
                    'DiscordMic'
                ]);

                audioStream.pipe(opusDecoder).pipe(ffmpegProcessIn.stdin);

                console.log('🎤 تم ربط صوتك بـ Grok!');
            });

            // 5. تشغيل FFmpeg لسحب صوت Grok من الـ Monitor الخاص بـ DiscordSink
            ffmpegProcessOut = spawn('ffmpeg', [
                '-f', 'pulse',
                '-i', 'DiscordSink.monitor', // التقاط الصوت من المخرج الوهمي
                '-fflags', 'nobuffer',
                '-flags', 'low_delay',
                '-ac', '2',
                '-ar', '48000',
                '-f', 's16le',
                '-acodec', 'pcm_s16le',
                'pipe:1'
            ]);

            // 6. ربط مخرج FFmpeg بمحرك صوت ديسكورد
            player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            const resource = createAudioResource(ffmpegProcessOut.stdout, {
                inputType: StreamType.Raw,
            });

            player.play(resource);
            connection.subscribe(player);

            // تعديل الرسالة لتأكيد اكتمال الربط
            await interaction.editReply('✅ **اكتمل الربط!** المتصفح في الخلفية يعمل (على grok.com) والصوت ثنائي الاتجاه يعمل الآن:\n🔊 صوت Grok → Discord\n🎤 صوتك → Grok');

        } catch (error) {
            console.error(error);
            await interaction.editReply('❌ حدث خطأ أثناء تشغيل الجلسة.');
        }
    }

    // --- أمر الإيقاف ---
    if (interaction.commandName === 'stop') {
        if (!browser) return interaction.reply({ content: '⚠️ لا توجد جلسة تعمل حالياً.', ephemeral: true });

        await interaction.reply('🛑 جاري إيقاف الجلسة وتفريغ الذاكرة (RAM)...');

        // إيقاف FFmpeg (المخرج والمدخل)
        if (ffmpegProcessOut) {
            ffmpegProcessOut.kill('SIGKILL');
            ffmpegProcessOut = null;
        }
        if (ffmpegProcessIn) {
            ffmpegProcessIn.kill('SIGKILL');
            ffmpegProcessIn = null;
        }

        // إغلاق المتصفح تماماً
        if (browser) {
            await browser.close();
            browser = null;
            page = null;
        }

        // قطع الاتصال الصوتي
        if (connection) {
            connection.destroy();
            connection = null;
        }
        if (player) {
            player.stop();
            player = null;
        }

        await interaction.editReply('✅ تم إغلاق كل شيء بنجاح وتوفير الموارد.');
    }
});

// تسجيل الدخول للبوت
client.login(process.env.DISCORD_TOKEN);
