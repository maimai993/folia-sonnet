// 调音台各级处理的参数类型、模式与频段。
/** 混响的声学预设。数值是协议里的编号，改动要同步 EqSettings.kt 的 ReverbPreset。 */
export const AUDIO_CONSOLE_REVERB_PRESETS = ['factory', 'hall', 'cathedral', 'plate'] as const;
export type AudioConsoleReverbPreset = typeof AUDIO_CONSOLE_REVERB_PRESETS[number];

/** 压缩器的四段。分频点与原生 MultibandCompressor 一致，改这里要改那边。 */
export const AUDIO_CONSOLE_COMPRESSOR_BANDS = ['low', 'mid', 'high', 'air'] as const;
export type AudioConsoleCompressorBandId = typeof AUDIO_CONSOLE_COMPRESSOR_BANDS[number];

/** 每段的显示名与频率范围（只用于界面，不参与 DSP）。 */
export const AUDIO_CONSOLE_COMPRESSOR_BAND_INFO: Record<
    AudioConsoleCompressorBandId,
    { label: string; range: string }
> = {
    low: { label: 'Low', range: '20 – 250 Hz' },
    mid: { label: 'Mid', range: '250 – 2000 Hz' },
    high: { label: 'High', range: '2000 – 8000 Hz' },
    air: { label: 'Air', range: '8000 – 20000 Hz' },
};

export type AudioConsoleCompressorBand = {
    enabled: boolean;
    /** 阈值 -48 ~ 0 dB。 */
    thresholdDb: number;
    /** 压缩比 1 ~ 20。 */
    ratio: number;
    /** 启动 0.5 ~ 100 ms。 */
    attackMs: number;
    /** 释放 10 ~ 1000 ms。 */
    releaseMs: number;
    /** 补偿增益 0 ~ 12 dB。 */
    makeupDb: number;
    /**
     * 软拐点宽度，2 ~ 18 dB。
     *
     * 小拐点（2 dB）进得干脆，适合鼓与贝斯；大拐点（12 dB 以上）过渡非常软，
     * 人声听不出「什么时候开始压」。出厂 6 dB 是两头都能用的折中。
     */
    kneeDb: number;
    /**
     * 平行压缩的混合比，0 ~ 1。
     *
     * 1 是常规串联压缩（整段都被压）。小于 1 时把压过的信号按比例混回未压的干声，
     * 瞬态保住、密度上来 —— 混音台上最常用的那招。因为压缩本身不引入延迟，
     * 这里等价于把增益量按比例缩放，不会产生梳状滤波。
     */
    mix: number;
};

export type AudioConsoleReverb = {
    enabled: boolean;
    preset: AudioConsoleReverbPreset;
    /** RT60：衰减 60 dB 所需时间，0.3 ~ 10 秒。 */
    rt60: number;
    /** 湿声相对干声的增益，-24 ~ 6 dB。 */
    roomLevelDb: number;
    /** 高频阻尼 0.02 ~ 0.9：越大尾巴越暗。切预设时跟着预设走，之后可单独调。 */
    damping: number;
    /** 预延迟 0 ~ 120 ms：直达声到第一次反射之间的空档，决定「有多远」。 */
    preDelayMs: number;
    /** 干湿比 0 ~ 1（等功率）：0 全干，1 全湿。 */
    mix: number;
    /** 暂停时让余音自然落下，而不是跟着播放器一起断。 */
    tailOnPause: boolean;
};

/** 声场宽度：M/S 加权。只用在中置之后的干声上，混响尾巴不重复处理。 */
export type AudioConsoleStereo = {
    enabled: boolean;
    /** 0 = 完全单声道，1 = 原样，2 = 侧向加倍（宽到喇叭外面）。 */
    width: number;
    /**
     * 低频单声道：这个频率以下的侧向分量归零，只留中置；0 表示关。
     *
     * 唱片里的低频常常两声道相位不一致，叠起来会互相抵消 —— 在外放与单声道蓝牙箱
     * 上就是「底鼓变薄、贝斯消失」。120 Hz 以下是母带处理的常用起点。
     */
    bassMonoHz: number;
    crossfeed: number;
    rotation: number;
};

/** 饱和的三种传输曲线，编号与 EqSettings.kt 的 SaturationMode 一致。 */
export const AUDIO_CONSOLE_SATURATION_MODES = ['tape', 'tube', 'diode'] as const;
export type AudioConsoleSaturationMode = typeof AUDIO_CONSOLE_SATURATION_MODES[number];

/**
 * 饱和 / 染色：给信号加谐波，EQ 与压缩都做不到这件事。
 *
 * 三个参数各管一件事：drive 决定「进曲线多深」，mix 决定「平行的比例」，
 * output 决定「出口多响」。饱和会把响度顶上去，所以 output 是手动的。
 */
export type AudioConsoleSaturation = {
    enabled: boolean;
    mode: AudioConsoleSaturationMode;
    /** 进曲线之前的增益，0 ~ 24 dB。 */
    driveDb: number;
    /** 干湿比 0 ~ 1（等功率）。0.3 ~ 0.5 是保留瞬态的平行饱和。 */
    mix: number;
    /** 出口电平，-24 ~ +6 dB。 */
    outputDb: number;
};

/** 链末前瞻限幅器的两个旋钮（前瞻固定 5 ms）。 */
export type AudioConsoleLimiter = {
    /** 输出上限，-6 ~ 0 dBFS。 */
    ceilingDb: number;
    /** 峰值过后的回落时间，40 ~ 500 ms。 */
    releaseMs: number;
};

export type AudioConsoleCompressor = {
    enabled: boolean;
    /** 2 段（Low / High）或 4 段。 */
    bandCount: 2 | 4;
    /** gentle：慢启动 + 自动补偿；flat：快、不补偿，用来做 A/B。 */
    profile: 'gentle' | 'flat';
    bands: Record<AudioConsoleCompressorBandId, AudioConsoleCompressorBand>;
    /**
     * 三级分频点（Hz），升序：Low|Mid、Mid|High、High|Air。
     *
     * 2 段模式只用第一级。改动它等于重画四段的边界，是「这台压缩器适配这套歌」的关键 ——
     * 男声的 Mid 起点通常比女声低，鼓组的 Air 起点通常比人声高。
     */
    crossovers: [number, number, number];
};

export type AudioConsoleCurve = 'geq' | 'peq';

/** 前置 EQ 的形状（十段增益本身在 audioEqualizerSettings 里）。 */
export type AudioConsoleFrontEq = {
    curve: AudioConsoleCurve;
    /** PEQ 的 Q；GEQ 时忽略。 */
    q: number;
    /** 十段之外的总增益。 */
    globalGainDb: number;
};

export type AudioConsolePostEq = {
    enabled: boolean;
    gains: number[];
    curve: AudioConsoleCurve;
    q: number;
    globalGainDb: number;
};

/**
 * 损失补偿（Opening-tuning loss compensation）。
 *
 * 开启调音链后，多段压缩、后置 EQ 的负增益、饱和的出口衰减、声场折中等处理会让整体
 * 响度比「关掉调音」时低一截 —— 用户的主观感受是「一开调音声音就变小、变闷」。
 *
 * 这一块在链末（限幅之前）做慢速自动增益：持续测量输出电平，把损失掉的响度补回去，
 * 同时按 amount 只补一部分（保留处理本身的动态），并用 maxGainDb 封顶，避免把底噪一起放大。
 */
export type AudioConsoleLossCompensation = {
    enabled: boolean;
    /** 补偿强度 0 ~ 1：1 表示把测得的损失全额补回，0.7 左右最自然。 */
    amount: number;
    /** 最大补偿增益 0 ~ 12 dB：再吵也不放超过它，防止噪声被顶起来。 */
    maxGainDb: number;
    /** AGC 响应时间 50 ~ 800 ms：越小跟得越紧，太大跟不上，太小会「喘」。 */
    responseMs: number;
};

/** 噪声门：把低于阈值的底噪/嘶声压下去，只让乐器与人的声音通过。 */
export type AudioConsoleNoiseGate = {
    enabled: boolean;
    /** 门限 -80 ~ -20 dBFS：低于它的信号被衰减。 */
    thresholdDb: number;
    /** 启动 0.5 ~ 50 ms：信号越过门限后门打开的速度。 */
    attackMs: number;
    /** 释放 20 ~ 600 ms：信号跌回门限后门关闭的速度，太短会「掐字」。 */
    releaseMs: number;
    /** 门关时的衰减量 -60 ~ -6 dB：不是完全静音，留一点底噪更自然。 */
    reductionDb: number;
};

/** 去齿音：对 4 ~ 10 kHz 的「嘶 / 呲」做动态压缩，让人声更顺耳。 */
export type AudioConsoleDeEsser = {
    enabled: boolean;
    /** 检测中心频率 4000 ~ 10000 Hz。 */
    frequencyHz: number;
    /** 阈值 -48 ~ 0 dB：齿音超过它才开始压。 */
    thresholdDb: number;
    /** 压缩比 1 ~ 10。 */
    ratio: number;
};

/** 低频增强：只抬 40 ~ 250 Hz 的一段，给薄声音补回量感，不碰中频。 */
export type AudioConsoleBassBoost = {
    enabled: boolean;
    /** 提升量 0 ~ 12 dB。 */
    gainDb: number;
    /** 中心频率 40 ~ 250 Hz。 */
    frequencyHz: number;
};

/** 声道平衡：-1 全左、0 居中、1 全右。 */
export type AudioConsoleBalance = {
    enabled: boolean;
    /** -1 ~ 1。 */
    value: number;
};

/**
 * 音色塑造：四个「一个旋钮调一种听感」的音色滑杆。
 *
 * 名字借自母带处理（都是行业里的常用说法），但每个都只是 0 ~ 6 dB 的一根推杆，
 * 不用懂中心频率与 Q 也能用 —— 想要「更通透」就推空气感，想要「人声更靠前」就推临场感。
 * 内部映射到固定的滤波器（见原生 MasteringStage），用户看不到这些细节。
 */
export type AudioConsoleToneShaping = {
    /** 空气感：9 kHz 高频搁架，越大越通透开扬。 */
    air: number;
    /** 临场感：3 kHz 钟形，越大人声与乐器越靠前、越清晰。 */
    presence: number;
    /** 温暖度：220 Hz 钟形，越大越厚、越有模拟味。 */
    warmth: number;
    /** 清晰度：削 350 Hz 附近的浑浊，越大人声越干净（内部是负增益）。 */
    clarity: number;
};

/**
 * 谐波激励（Exciter）：给高频补一点「泛音的亮度」，让声音听起来更贵、更清晰。
 *
 * 和音色塑造里的「空气感」不同：空气感只是抬高 9 kHz 的既有频率，激励是**生成**原本
 * 没有的谐波（对高频做轻微饱和），所以即使源文件本身高频不多，也能听出"开了窗"的感觉。
 * 只有一个 amount 旋钮，内部固定激励频率与驱动量，用户不必懂谐波是什么。
 */
export type AudioConsoleExciter = {
    enabled: boolean;
    /** 激励强度 0 ~ 1：越大泛音越多。 */
    amount: number;
    /** 干湿比 0 ~ 1：激励信号混回多少。 */
    mix: number;
};

/**
 * 瞬态塑形（Transient）：单独调「起音的冲击力」，不动延音。
 *
 * 往上推，鼓点和拨弦更有力量（咬字更清楚）；往下压，声音更柔、更平顺。
 * 只有一根 -1 ~ 1 的推杆，正数是增强、负数是柔化，内部用包络的上升沿做增益。
 */
export type AudioConsoleTransient = {
    enabled: boolean;
    /** -1 全柔化 ~ 0 不动 ~ 1 全增强。 */
    amount: number;
};

/**
 * 等响度（Loudness）：小音量时人耳听不到高低两头，这一项把它们补回来。
 *
 * 这是 Fletcher-Munson 曲线的实际用途：夜里把音量拧小，低音消失、细节也没了 ——
 * 打开它，低频与高频按曲线抬起，小声听也还丰满。一个 amount 旋钮。
 */
export type AudioConsoleLoudness = {
    enabled: boolean;
    /** 补偿强度 0 ~ 1。 */
    amount: number;
};

/**
 * 去喷麦（De-plosive）：压掉人声里「扑 / 噗」这种低频气流冲击。
 *
 * 去齿音管 4 ~ 10 kHz 的「嘶」，它管的是 200 Hz 以下的「噗」——两种最常见的录音瑕疵，
 * 各管一段。只有一个 reduction 旋钮，内部固定检测频段与阈值。
 */
export type AudioConsoleDePlosive = {
    enabled: boolean;
    /** 衰减量 -24 ~ 0 dB：负得越多压得越狠。 */
    reductionDb: number;
};

/**
 * 工作室 · 响度标准化：整曲电平缓慢推向目标响度。
 * 旧存储键名保留；单位是 RMS dBFS，不是 LUFS 或 dBTP。
 */
export type AudioConsoleNormalize = {
    enabled: boolean;
    /** -20 ~ -9 dBFS RMS。 */
    targetLufs: number;
    /** 将 RMS 目标再降低 1 dB。 */
    truePeak: boolean;
};

/** 工作室 · 音频修复：去咔嗒 / 去嗡声 / 降噪，三类瑕疵各自独立。 */
export type AudioConsoleRestore = {
    declick: boolean;
    hum: boolean;
    denoise: boolean;
    /** 修复强度 0 ~ 1。 */
    amount: number;
};

/** 工作室 · 进阶效果：动态 EQ / M/S 声场 / 展宽 / 人声增强。 */
export type AudioConsoleAdvanced = {
    dynamicEq: boolean;
    /** 动态 EQ 中心频率 80 ~ 400 Hz。 */
    dynamicEqFreq: number;
    /** 衰减量 0 ~ 12 dB。 */
    dynamicEqAmount: number;
    /** 人声增强 0 ~ 1。 */
    vocalBoost: number;
};

/** 工作室 · 智能场景：曲风预设 / A/B 对比 / 耳机校准。 */
export type AudioConsoleScene = {
    /** flat/pop/rock/jazz/classical/electronic/vocal。 */
    genre: 'flat' | 'pop' | 'rock' | 'jazz' | 'classical' | 'electronic' | 'vocal';
    /** A/B：打开时整条链旁通，直接听原声。 */
    compare: boolean;
    /** flat/airpods/sony/sennheiser。 */
    headphone: 'flat' | 'airpods' | 'sony' | 'sennheiser';
    /** 场景微调强度 0 ~ 1。 */
    amount: number;
};

/** 工作室块：四大方向 12 项，可缺省。 */
export type AudioConsoleStudio = {
    normalize: AudioConsoleNormalize;
    restore: AudioConsoleRestore;
    advanced: AudioConsoleAdvanced;
    scene: AudioConsoleScene;
};

/** 母带处理块：损失补偿 + 九项修复/塑造/增强效果，作为一个可缺省的扩展块推给原生。 */
export type AudioConsoleMastering = {
    compensation: AudioConsoleLossCompensation;
    noiseGate: AudioConsoleNoiseGate;
    deEsser: AudioConsoleDeEsser;
    dePlosive: AudioConsoleDePlosive;
    bassBoost: AudioConsoleBassBoost;
    exciter: AudioConsoleExciter;
    transient: AudioConsoleTransient;
    tone: AudioConsoleToneShaping;
    loudness: AudioConsoleLoudness;
    balance: AudioConsoleBalance;
    /** 工作室块：四大方向 12 项，可缺省。 */
    studio: AudioConsoleStudio;
};

export type AudioConsoleSettings = {
    reverb: AudioConsoleReverb;
    compressor: AudioConsoleCompressor;
    frontEq: AudioConsoleFrontEq;
    postEq: AudioConsolePostEq;
    stereo: AudioConsoleStereo;
    saturation: AudioConsoleSaturation;
    limiter: AudioConsoleLimiter;
    /** 可缺省：老存档没有这一块时按中性补齐（全部关闭）。 */
    mastering: AudioConsoleMastering;
};
