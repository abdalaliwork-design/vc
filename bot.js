const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const fs = require('fs');

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
let ffmpegProcess = null;
let connection = null;
let player = null;

// تعريف أوامر السلاش (Slash Commands)
const commands =[
    {
        name: 'start',
        description: 'يبدأ تشغيل متصفح Grok وبث الصوت إلى القناة الصوتية 🎙️',
    },
    {
        name: 'stop',
        description: 'يوقف الجلسة ويغلق المتصفح لتوفير الموارد 🛑',
    }
];

client.on('ready', async () => {
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
            });

            // 2. تشغيل المتصفح (Headless: false) داخل شاشة Xvfb الوهمية لضمان عمل الصوت
            browser = await chromium.launch({
                headless: false, 
                args:[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // مهم لتقليل استهلاك الرام في Railway
                    '--autoplay-policy=no-user-gesture-required' // السماح بتشغيل الصوت تلقائياً
                ]
            });

            const context = await browser.newContext();

            // 3. حقن الكوكيز الخاصة بتسجيل الدخول (من Railway Variables أو الملف)
            let cookies = null;

            if (process.env.GROK_COOKIES) {
                try {
                    cookies = JSON.parse(process.env.GROK_COOKIES);
                    console.log('✅ تم جلب الكوكيز من متغيرات Railway بنجاح.');
                } catch (err) {
                    console.error('❌ خطأ في تحليل JSON الخاص بالكوكيز من المتغيرات!', err);
                    interaction.channel.send('⚠️ خطأ في قراءة متغير GROK_COOKIES، تأكد من صحة الكود المنسوخ.');
                }
            } else if (fs.existsSync('./cookies.json')) {
                cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
                console.log('✅ تم جلب الكوكيز من ملف cookies.json المحلي.');
            }

            if (cookies) {
                await context.addCookies(cookies);
            } else {
                interaction.channel.send('⚠️ تنبيه: لم يتم العثور على كوكيز (لا في Railway ولا في الملف). قد يُطلب تسجيل الدخول يدوياً.');
            }

            // ضمان فتح Tab واحد فقط لتوفير استهلاك الرام (< 1GB)
            page = await context.newPage();
            await page.goto('https://grok.com', { waitUntil: 'networkidle' });

            // 4. تشغيل FFmpeg لسحب الصوت من الـ Monitor الخاص بـ DiscordSink
            ffmpegProcess = spawn('ffmpeg',[
                '-f', 'pulse',
                '-i', 'DiscordSink.monitor', // التقاط الصوت من المخرج الوهمي
                '-fflags', 'nobuffer',       // منع التخزين المؤقت لتسريع النقل
                '-flags', 'low_delay',       // فرض وضع الـ Low Delay
                '-ac', '2',                  // قنوات الصوت (Stereo)
                '-ar', '48000',              // معدل التردد الصوتي القياسي لديسكورد
                '-f', 's16le',               // صيغة الإخراج الخام
                '-acodec', 'pcm_s16le',
                'pipe:1'                     // إرسال الناتج إلى stdout
            ]);

            // 5. ربط مخرج FFmpeg بمحرك صوت ديسكورد
            player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            const resource = createAudioResource(ffmpegProcess.stdout, {
                inputType: StreamType.Raw,
            });

            player.play(resource);
            connection.subscribe(player);

            // تعديل الرسالة لتأكيد اكتمال الربط
            await interaction.editReply('✅ **اكتمل الربط!** المتصفح في الخلفية يعمل (على grok.com) والصوت يتم بثه الآن إلى القناة.');

        } catch (error) {
            console.error(error);
            await interaction.editReply('❌ حدث خطأ أثناء تشغيل الجلسة.');
        }
    }

    // --- أمر الإيقاف ---
    if (interaction.commandName === 'stop') {
        if (!browser) return interaction.reply({ content: '⚠️ لا توجد جلسة تعمل حالياً.', ephemeral: true });

        await interaction.reply('🛑 جاري إيقاف الجلسة وتفريغ الذاكرة (RAM)...');

        // إيقاف FFmpeg
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;
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
