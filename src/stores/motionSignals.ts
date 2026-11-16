import { motionValue, type MotionValue } from 'framer-motion';
import { PLAYER_BOTTOM_BAR_BASE_OFFSET_PX } from '../utils/playerBottomBarLayout';

// src/stores/motionSignals.ts
// The app's per-frame signals, held as MotionValue instances rather than React state.
//
// These are the values that change every frame while a song plays: playback position, the lyric
// clock, and the analyser's band energies. They must never become reactive store state — writing
// `currentTime.get()` into a store would re-render the tree at frame rate. See
// skills/frontend-runtime-guardrails.
// 全局底部基线也在这里：拖动期间它是 pointer-move 频率的信号，不能进入 React/store state。
//
// What this module owns is only the *instances*. Their identity is stable for the process
// lifetime, so reading one here costs nothing and never triggers a render; consumers subscribe
// with useTransform / useMotionValueEvent, or read `.get()` inside their own RAF loop.
//
// Created at module scope rather than by a hook because App.tsx used to own them and hand them
// down: every consumer then had to be given the instance as a prop, and the instances had to sit
// in dependency arrays that could never actually change.

export type AudioBandSignals = {
    bass: MotionValue<number>;
    lowMid: MotionValue<number>;
    mid: MotionValue<number>;
    vocal: MotionValue<number>;
    treble: MotionValue<number>;
    spectrum: MotionValue<Uint8Array<ArrayBuffer>>;
};

/** Playback position of the deck the listener actually hears, in seconds. */
export const currentTime = motionValue(0);

/**
 * 音频**真的**在不在播（1 / 0）。
 *
 * 和 `playerState` 严格不是一回事：状态机只记「用户 / 程序自己发起的动作」，
 * 任何外部打断（别的 App 抢走音频焦点，系统直接把 media 暂停）都进不了状态机 ——
 * 于是状态机停在 PLAYING，音频却已经停了。
 *
 * 壁纸 / 悬浮小窗那一路只关心「位置会不会自己往前走」，它认的是音频本身，
 * 不是状态机：认错就会在歌曲已经停住的时候继续按墙钟外推，把歌词推到实际位置前面去。
 */
export const actuallyPlaying = motionValue(0);

/** The lyric clock. Separate from `currentTime`: it carries the per-song timeline offset. */
export const lyricCurrentTime = motionValue(0);

/**
 * The song hand-off of an automix/crossfade blend, as the main window's visualizer draws it: how far
 * it has come (0..1, transitionCue's getTransitionHandoffProgress), and the incoming track's lyric
 * clock. Written by the visualizer bridge while a blend holds the picture on the outgoing track.
 */
export const handoffProgress = motionValue(0);
export const handoffLyricCurrentTime = motionValue(0);

/** Overall analyser energy, 0..1. */
export const audioPower = motionValue(0);

export const bass = motionValue(0);
export const lowMid = motionValue(0);
export const mid = motionValue(0);
export const vocal = motionValue(0);
export const treble = motionValue(0);
export const spectrum = motionValue(new Uint8Array(0));

/**
 * 音轨分离出的十四条音乐曲线（0..1，对该曲自己归一），由 beatFxLive.tickBeatFx 在**同一个**
 * playback RAF 里顺手采样写入 —— 不新增帧循环。与 `audioBands` 的区别是它们来自 htdemucs
 * 的整曲分析，不受音量、EQ、实时 analyser 抖动影响，还能分得清「低频 / 人声 / 鼓」。
 *
 * 前四条是整轨 RMS，其余是同一批已分离波形再分频得到的细分维度，模型不换、APK 不涨体积。
 * 没有分析数据时全是 0，读它们的样式自然静止。详见 services/analysis/musicEnvelope.ts。
 */
export type MusicMotionKind =
    | 'bass' | 'vocals' | 'other' | 'energy'
    | 'bassSub' | 'vocalAir' | 'brightness' | 'kick' | 'snare' | 'hat'
    // 四条语义轨：drums 只有节奏类画面读，vocalBody / harmony / pad 分别给歌词与氛围。
    | 'drums' | 'vocalBody' | 'harmony' | 'pad'
    // 语义层：发声、基频、和弦（原生 AudioFeatures 从已分离波形上算，不跑额外模型）。
    | 'vocalVoicing' | 'vocalPitch' | 'chordRoot' | 'chordMinor';

export const musicEnvelopes: Record<MusicMotionKind, MotionValue<number>> = {
    bass: motionValue(0),
    vocals: motionValue(0),
    other: motionValue(0),
    energy: motionValue(0),
    bassSub: motionValue(0),
    vocalAir: motionValue(0),
    brightness: motionValue(0),
    kick: motionValue(0),
    snare: motionValue(0),
    hat: motionValue(0),
    drums: motionValue(0),
    vocalVoicing: motionValue(0),
    vocalPitch: motionValue(0),
    chordRoot: motionValue(0),
    chordMinor: motionValue(0),
    vocalBody: motionValue(0),
    harmony: motionValue(0),
    pad: motionValue(0),
};

/**
 * 去掉鼓组之后的「身体」起伏（0..1）。
 *
 * 各样式原来拿 `energy`（整轨 RMS）当整体呼吸用，可是鼓是最容易把 RMS 抬起来的东西 ——
 * 海报、水墨、雾这类本来没有节奏感的画面，也跟着底鼓一拍一颤。这条曲线取
 * 「其余乐器 / 人声 / 亮度」三者里最大的那条：都落在 150Hz 以上，底鼓的基频和主要谐波
 * 都进不来，鼓点再重也顶不起它。
 *
 * 由 beatFxLive 在**同一个** playback RAF 里算出，并做一次轻平滑 —— 读起来是呼吸，不是抖动。
 * 它是派生量，不是包络里的一维：不进 MUSIC_ENVELOPE_KINDS，也不进缓存，改它不会让
 * 用户已有的整曲分析失效。
 */
export const musicBody = motionValue(0);

/**
 * 两条**语义总线**：一条只装人声，一条只装伴奏。样式按「这个效果在画什么」选一条，
 * 不再各自从 `musicBody` 里猜。
 *
 *   musicVocals  —— vocalBody 为主，vocalAir 补气声，vocals 兜底。
 *                   所有带字的位移（歌词行浮动、气泡上浮、珠串下沉、阶梯抬升）只读它：
 *                   底鼓的基频在 drums 轨里，进不到这条线上，因此字不会再跟着鼓点抖。
 *   musicHarmony —— harmony 为主，pad 补低频的托，brightness 补明暗。
 *                   海报、水墨、雾、光束这些「没有节奏感」的画面读它：鼓点同样进不来，
 *                   但和声厚薄、乐句进出、高频明暗都在。
 *
 * 都是派生量，在 beatFxLive 的同一个 playback RAF 里算，不进缓存、不改包络版本。
 */
export const musicVocals = motionValue(0);
export const musicHarmony = motionValue(0);

/**
 * 「这一帧有人在唱吗」—— 0..1，来自人声轨的自相关周期可信度。
 *
 * 和 `musicVocals` 的区别是**语义**而不是数值：`musicVocals` 说「人声轨此刻有多响」，
 * 这一条说「此刻有没有一个稳定的基频」。鼓的余音、混响尾巴、伴奏里的小提琴都能把前者
 * 顶起来，但它们没有「一个音高」，后者会落回 0。歌词类画面的位移读这一条，
 * 才能做到「唱的时候动、气口停、间奏不动」。
 */
export const musicVoicing = motionValue(0);

/**
 * 唱到多高 —— 0..1，映射 55–880Hz 四个八度。清音帧为 0。
 *
 * 用来让画面跟着**旋律**走：高音抬起来、低音沉下去。读能量做不到这件事，
 * 因为副歌的响度和主歌一样高，但音高不一样。
 */
export const musicPitch = motionValue(0);

/**
 * 和弦：`musicChordRoot` 是根音 / 12（0..1），`musicChordMinor` 0 大三和弦、1 小三和弦。
 *
 * 两者都是逐帧的，切换处会跳变；要「跟着和弦换色」的画面请自己在消费端做淡入，
 * 不要指望曲线本身平滑 —— 和弦本来就是离散的。
 */
export const musicChordRoot = motionValue(0);
export const musicChordMinor = motionValue(0);

/** 整曲调性：根音 / 12 与大小调。一首歌内基本不变，适合做基色/色温的长期基准。 */
export const musicKeyRoot = motionValue(0);
export const musicKeyMinor = motionValue(0);

/**
 * 「唱得比中音高多少」—— -1..1，已经乘过发声度，没在唱时是 0。
 *
 * 为什么单独生一条：`musicPitch` 自己是个 0..1 的坐标，各样式要的是「相对中音偏了多少」，
 * 每处再减 0.5 再乘系数，迟早会有一处忘了乘发声度，于是间奏里画面还在往上飘。
 * 这里一次算好，样式只管乘像素。
 */
export const musicLyricLift = motionValue(0);

/**
 * 「这一段该动吗」—— 0..1 的段落活跃度门槛。
 *
 * `musicBody` 只说此刻有多响，不区分「安静的前奏」和「副歌」：两者都可能是 0.35，
 * 但前者画面该几乎静止，后者该放开动。差别不在瞬时响度，而在**这首歌自己的尺度上**
 * 这一段算不算强。
 *
 * 所以这条曲线拿 `musicBody` 和一个缓慢衰减的全曲峰值比：安静段远低于峰值 → 落到 0；
 * 副歌接近峰值 → 到 1。上升快、下降慢（起手要跟得上乐句进副歌，落下要够慢，
 * 免得一个字一个字地闪），于是它读起来是「段落」，不是「节拍」。
 *
 * 用途：位移类效果（字的漂浮、珠串下沉、气泡上浮）乘上它 —— 安静段几乎不动，
 * 副歌才放开。缩放与明暗不必乘：那些本来就该一直有呼吸。
 *
 * 同样是派生量，不进包络、不进缓存。没有分轨数据时固定给 1（不做门槛），
 * 免得曲线没补到的段落整个画面僵住。
 */
export const musicSway = motionValue(1);

/**
 * Beat-synchronous impact envelopes, decaying after each beat / downbeat of the playing track:
 * 0..1, times 智能动感模式's 轻拍 / 重拍 strengths (0..2). Only driven while 智能动感模式 is on and
 * something on screen draws beat FX (see src/services/beatFx); they stay at 0 otherwise, so
 * consumers can read them unconditionally.
 */
export const beatImpact = motionValue(0);
export const downbeatImpact = motionValue(0);

/** The band set as one stable object, so it can be passed straight to a visualizer. */
export const audioBands: AudioBandSignals = { bass, lowMid, mid, vocal, treble, spectrum };

/** Global bottom baseline offset in px; positioning writes it at pointer-move frequency. */
export const playerBottomBarLiveOffset = motionValue(PLAYER_BOTTOM_BAR_BASE_OFFSET_PX);

/**
 * 思索提示胶囊跟随的光标位置，px。
 *
 * 悬停在可教学区域期间由 pointermove 写入，频率与指针事件同步。放在这里而不是
 * usePonderStore，理由和上面那条底部基线一样：它是每帧值，进 React state 就等于
 * 让整棵树按指针移动频率重渲染。store 那边只留「悬停的是哪个目标」这个离散事实。
 */
export const ponderPointerX = motionValue(0);
export const ponderPointerY = motionValue(0);
