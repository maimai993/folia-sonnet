import { useMemo } from 'react';
import { motionValue, useTransform, type MotionValue } from 'framer-motion';
import { musicHarmony, musicVocals, musicVoicing } from '../../stores/motionSignals';
import type { MusicEnvelopeKind } from '../analysis/musicEnvelope';
import { BEAT_EFFECT_IDS } from './beatEffects';
import { effectMode, modeHasSmartBeat } from './beatFxModePolicy';

// src/services/beatFx/effectTracks.ts
// 每个智能动感效果**读哪条音轨**，集中在这里声明，是唯一事实来源。
//
// 这条链路只服务「其余样式」：每个效果只读自己登记的那条语义轨（人声 / 和声 / 氛围 /
// 亮度）的上升沿，触发一次柔和的短脉冲 + 回弹 + 静息归位。列表里**没有任何鼓轨**
// （kick / snare / hat / drums），所以画面不会跟着鼓点一顿一顿，更不会出现整页震动、
// 鼓点频闪（闪光弹）或歌词左右抖。
//
// 花火 / 商籁 / 镜台不在这里：那三套走各自的 beatImpact / downbeatImpact 原生推镜震动
// （上游「最开始没改」的最佳效果），本就不该再往里加效果。整页鼓点震动只属于这三套，
// 其余样式只在这里读自己那条非鼓点的轨。
//
// ① 纯文字 / 静态画面与模组样式（prompt / bilibili / kinetic / still / mod:*）在
// beatFxModePolicy 里被判为禁做，stepEffectPulses 对它们输出恒 0；背景效果
// （latent.pulse）不属于任何歌词样式，照常有自己的脉冲，不被误伤。
//
// 脉冲状态挂在 beatFxLive.tickBeatFx 这**唯一**的 playback RAF 上逐帧推进，不新增帧循环。

/** 一条轨在效果里的权重；同一效果里的权重和约为 1。 */
export type EffectTrackMix = Partial<Record<MusicEnvelopeKind, number>>;

/** 词作者：一个字幕层能「看见」的轨道只有人声，鼓 / 贝斯都不在这里。 */
const LYRICS: EffectTrackMix = { vocalBody: 0.78, vocalAir: 0.22 };

/** 氛围：只读伴奏的厚薄与明暗，不读任何打击乐。 */
const AMBIENCE: EffectTrackMix = { harmony: 0.74, pad: 0.18, brightness: 0.08 };

/**
 * 只登记真正被渲染层读取（readEffectTrack / useEffectTrack）的效果。
 * 上游那些走 getBeatEffectStrength 的原生效果（时计鼓面、町景鼓涟漪、凝彩色块…）
 * 不进这张表 —— 它们有自己的数据路径，不需要也不该在这里算脉冲。
 */
export const EFFECT_TRACKS: Readonly<Record<string, EffectTrackMix>> = {
    // 背景：低频铺底，不属于任何歌词样式。
    [BEAT_EFFECT_IDS.latentPulse]: { bassSub: 1 },

    // 画面 / 图形：只读自己那条非鼓点的语义轨。
    [BEAT_EFFECT_IDS.machiNeonGlow]: { vocalAir: 1 },
    [BEAT_EFFECT_IDS.nebbiaFogDensity]: { pad: 0.5, harmony: 0.5 },
    [BEAT_EFFECT_IDS.pendoloJewelGlow]: { vocalBody: 0.7, vocalAir: 0.3 },

    // 歌词层：只读人声。
    [BEAT_EFFECT_IDS.classicPulseGlow]: LYRICS,
    [BEAT_EFFECT_IDS.classicVocalShine]: { vocalAir: 1 },
    [BEAT_EFFECT_IDS.cadenzaHaloBreath]: LYRICS,
    [BEAT_EFFECT_IDS.cadenzaScatterDrift]: { vocalBody: 0.72, vocalAir: 0.28 },
    [BEAT_EFFECT_IDS.cappellaVoicePop]: { vocalBody: 1 },
    [BEAT_EFFECT_IDS.cappellaBubbleSway]: LYRICS,
    [BEAT_EFFECT_IDS.claddaghRingTilt]: { harmony: 0.8, pad: 0.2 },
    [BEAT_EFFECT_IDS.claddaghBeadHop]: LYRICS,
    [BEAT_EFFECT_IDS.partitaStepTread]: { vocalBody: 1 },
    [BEAT_EFFECT_IDS.partitaTierRise]: LYRICS,
    [BEAT_EFFECT_IDS.tiltLeanSway]: { harmony: 0.7, pad: 0.3 },
    [BEAT_EFFECT_IDS.tiltMainReveal]: LYRICS,
    // 提示词：① 禁做，保留条目让恒 0 的判据落到具体 id 上。
    [BEAT_EFFECT_IDS.promptTypePace]: { harmony: 0.75, pad: 0.25 },
    [BEAT_EFFECT_IDS.promptBoxFly]: LYRICS,

    // 氛围画面：只读伴奏。
    [BEAT_EFFECT_IDS.monetBrushBloom]: AMBIENCE,
    [BEAT_EFFECT_IDS.monetKeyGlow]: { vocalAir: 0.55, brightness: 0.45 },
    [BEAT_EFFECT_IDS.fumeInkWeight]: { harmony: 0.8, brightness: 0.2 },
    [BEAT_EFFECT_IDS.fumeVeilCalm]: { pad: 0.6, harmony: 0.4 },
    [BEAT_EFFECT_IDS.lumiereBeamWidth]: AMBIENCE,
    [BEAT_EFFECT_IDS.lumiereLineSpark]: { brightness: 1 },
};

const FALLBACK: EffectTrackMix = { harmony: 1 };

/**
 * 这些效果画的是**字**，所以要跟「此刻在不在唱」走，而不是只跟「此刻多响」走。
 * 只跟响度有两个毛病：气口（字还在，人已经停了）画面还在动；间奏（没人唱但伴奏很响）
 * 画面也动。乘一道 `vocalVoicing` 之后，唱的时候动、换气时收、间奏静止。
 * 留 0.35 的底：完全归零会让画面像被钉住，且 YIN 在气声上偶尔误判清音。
 */
const VOICE_GATED: ReadonlySet<string> = new Set([
    BEAT_EFFECT_IDS.classicPulseGlow,
    BEAT_EFFECT_IDS.cadenzaHaloBreath,
    BEAT_EFFECT_IDS.cadenzaScatterDrift,
    BEAT_EFFECT_IDS.cappellaBubbleSway,
    BEAT_EFFECT_IDS.claddaghBeadHop,
    BEAT_EFFECT_IDS.partitaTierRise,
    BEAT_EFFECT_IDS.tiltMainReveal,
    BEAT_EFFECT_IDS.promptBoxFly,
]);

/** 发声门控：有唱接近 1，换气靠近 0.35。 */
const voiceGate = (voicing: number): number => 0.35 + 0.65 * Math.max(0, Math.min(1, voicing));

/** 这个效果的轨道组合；没登记的走伴奏（安全的一侧：不含鼓）。 */
export const effectTrackMix = (id: string): EffectTrackMix => EFFECT_TRACKS[id] ?? FALLBACK;

// ───────────────────────── 脉冲整形 ─────────────────────────

/**
 * 「冲到峰值 → 快速回落 → 一次小回弹 → 归零」的解析包络：
 *   env(t) = e^(-t/τ) · (1 - a + a·cos(2πft))
 * 恒 ≥ 0（1-2a > 0），所以不会把缩放/透明度顶到负值；t=0 恰好是峰值 1，
 * 之后随 cos 起伏衰减 —— 那一次起伏就是「震一下、弹一下」。
 *
 * 只有一档「柔」的形状：τ 大、f 低，一波约 0.6s，不应期长，水墨/雾/笔触/字形
 * 不会一顿一顿；乐句级的上升沿触发，绝不跟每记鼓点频闪。峰值沿用现有幅度，
 * 消费端的系数一律没动 —— 明显（静息严格归零）但不浓（系数不加倍）。
 */
interface PulseProfile {
    tau: number;
    freq: number;
    wobble: number;
    refractory: number;
    life: number;
}
const PULSE_PROFILE: PulseProfile = { tau: 0.28, freq: 2.1, wobble: 0.26, refractory: 0.38, life: 0.95 };

/** 上升沿门槛：要比慢基线高出一截、且这一帧确实在往上走，才算「来了一下」。 */
const ONSET_OVER_BASELINE = 0.055;
const ONSET_MIN_RISE = 0.012;
/** 慢基线时间常数：比一拍长、比一句短，只有乐句/拍点的起来能越过去。 */
const BASELINE_TAU = 0.5;

interface PulseState {
    baseline: number;
    prev: number;
    t0: number;
    amp: number;
    lastTrigger: number;
    active: boolean;
}
const makePulseState = (): PulseState => ({
    baseline: 0, prev: 0, t0: -1, amp: 0, lastTrigger: -1, active: false,
});

/** 单个脉冲的一帧：读源值、判上升沿、推包络。全在模块级状态里，不产生临时对象。 */
const stepPulse = (state: PulseState, raw: number, profile: PulseProfile, nowSec: number, dtSec: number): number => {
    state.baseline += (raw - state.baseline) * (1 - Math.exp(-dtSec / BASELINE_TAU));
    const rise = raw - state.prev;
    const over = raw - state.baseline;
    if (over > ONSET_OVER_BASELINE && rise > ONSET_MIN_RISE && nowSec - state.lastTrigger > profile.refractory) {
        state.t0 = nowSec;
        state.lastTrigger = nowSec;
        // 峰值沿用现有幅度：最小 0.45 保证看得见，最大 1 —— 绝不放大系数。
        state.amp = Math.min(1, Math.max(0.45, over / 0.25));
        state.active = true;
    }
    state.prev = raw;
    if (!state.active) return 0;
    const t = nowSec - state.t0;
    if (t > profile.life) {
        state.active = false;
        return 0;
    }
    const env = Math.exp(-t / profile.tau)
        * (1 - profile.wobble + profile.wobble * Math.cos(2 * Math.PI * profile.freq * t));
    if (env < 0.004) {
        state.active = false;
        return 0;
    }
    return state.amp * env;
};

/** 每个效果的脉冲 MotionValue：懒创建，身份稳定，订阅它不会触发 React 重渲染。 */
const PULSE_VALUES: Record<string, MotionValue<number> | undefined> = {};
const pulseValue = (id: string): MotionValue<number> => {
    const found = PULSE_VALUES[id];
    if (found) return found;
    const created = motionValue(0);
    PULSE_VALUES[id] = created;
    return created;
};

/** 效果 id → 预先展开的 (轨, 权重) 数组，避免每帧在 RAF 里造临时数组。 */
const MIX_ENTRIES: Record<string, Array<[MusicEnvelopeKind, number]>> = {};
for (const [id, mix] of Object.entries(EFFECT_TRACKS)) {
    MIX_ENTRIES[id] = Object.entries(mix) as Array<[MusicEnvelopeKind, number]>;
}
const PULSE_STATES: Record<string, PulseState> = {};
const PULSE_IDS = Object.keys(EFFECT_TRACKS);

/**
 * 每帧推进所有效果的脉冲值。由 beatFxLive.tickBeatFx 在**已有的** playback RAF 里调用，
 * 不新增帧循环；`frame` 就是那一帧已经算好的各轨曲线/回退值。
 *
 * 这里**不接收、也不叠加任何鼓点冲击**：整页鼓点震动只属于花火/商籁/镜台的
 * beatImpact 原生路径，其余样式一律只跟自己那条非鼓点语义轨的乐句起伏。
 */
export const stepEffectPulses = (
    // Partial：允许某一轨这一帧没算出来（回退 0），也让单测能只填关心的那几条轨。
    frame: Readonly<Partial<Record<MusicEnvelopeKind, number>>>,
    nowSec: number,
    dtSec: number,
): void => {
    for (const id of PULSE_IDS) {
        const mode = effectMode(id);
        if (!modeHasSmartBeat(mode)) {
            // ① 禁做名单、② 原生三套、模组样式：输出恒 0。
            // 背景效果（latent.*）不在名单里，照常有自己的脉冲，不会被这里误伤。
            pulseValue(id).set(0);
            continue;
        }
        let raw = 0;
        const entries = MIX_ENTRIES[id];
        for (let index = 0; index < entries.length; index += 1) {
            const [kind, weight] = entries[index];
            raw += (frame[kind] ?? 0) * weight;
        }
        raw = Math.min(1, raw);
        const state = PULSE_STATES[id] ?? (PULSE_STATES[id] = makePulseState());
        const value = stepPulse(state, raw, PULSE_PROFILE, nowSec, dtSec);
        const mv = pulseValue(id);
        if (mv.get() !== value) mv.set(value);
    }
};

/** 切歌 / 关掉智能动感时把所有脉冲归零，免得残留的上一首状态在下一首开头闪一下。 */
export const resetEffectPulses = (): void => {
    for (const state of Object.values(PULSE_STATES)) {
        state.baseline = 0; state.prev = 0; state.t0 = -1; state.amp = 0;
        state.lastTrigger = -1; state.active = false;
    }
    for (const mv of Object.values(PULSE_VALUES)) if (mv && mv.get() !== 0) mv.set(0);
};

/**
 * 非 React 调用方（Pixi 的每帧 update）用这个：读该效果这一帧的**脉冲**值。
 * 值域仍是 0..1，峰值不变，所以各渲染文件里原有的映射系数一个都不用改。
 */
export const readEffectTrack = (id: string): number => {
    const value = pulseValue(id).get();
    if (VOICE_GATED.has(id)) return Math.min(1, value * voiceGate(musicVoicing.get()));
    return Math.min(1, value);
};

/** React 调用方用这个：一条跟着轨道走的 MotionValue，可直接进 useTransform / style。 */
export const useEffectTrack = (id: string): MotionValue<number> => {
    const pulse = pulseValue(id);
    const gated = VOICE_GATED.has(id);
    const inputs = useMemo(
        () => (gated ? [pulse, musicVoicing] : [pulse]),
        [pulse, gated],
    );
    return useTransform(inputs, (values: number[]) => {
        const value = values[0] ?? 0;
        if (gated) return Math.min(1, value * voiceGate(values[1] ?? 0));
        return Math.min(1, value);
    });
};

/**
 * 两条总线也在这里留一个入口：歌词层与氛围层的「整体呼吸」。
 * 有些效果本来就是整层的慢呼吸，不需要精确到某一轨，但需要保证它不含鼓：
 * `musicVocals` / `musicHarmony` 由 beatFxLive 从同一批语义轨算出来，样式直接引用即可。
 */
export const effectBus = {
    lyrics: musicVocals,
    ambience: musicHarmony,
} as const;
