import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MusicEnvelopeKind } from '../../../src/services/analysis/musicEnvelope';
import { BEAT_EFFECT_IDS } from '../../../src/services/beatFx/beatEffects';
import { readEffectTrack, resetEffectPulses, stepEffectPulses } from '../../../src/services/beatFx/effectTracks';
import { musicVoicing } from '../../../src/stores/motionSignals';

// 本次「分别改接口和调」后，脉冲层的核心不变量：
//   · 效果是「一下一下」的，静息严格归零（不再是常年顶峰值、看着跟没有一样）；
//   · 峰值沿用现有幅度、绝不超过 1（不叠鼓点、不加倍、不「太浓」）；
//   · **任何歌词/氛围效果都不读鼓轨**：只给鼓点冲击时全部恒 0，不会有闪光弹、
//     整页震动或歌词左右抖。整页鼓点震动只属于花火/商籁/镜台的 beatImpact 原生路径。

/** 只填用到的轨；没填的在 stepEffectPulses 里按 `?? 0` 处理。 */
const frameWith = (partial: Partial<Record<MusicEnvelopeKind, number>>): Readonly<Partial<Record<MusicEnvelopeKind, number>>> => partial;

/** 一帧 16ms；t 是这一帧的时刻（秒）。stepEffectPulses 不再接收拍点冲击。 */
const step = (frame: Readonly<Partial<Record<MusicEnvelopeKind, number>>>, t: number) =>
    stepEffectPulses(frame, t, 0.016);

const STEADY_VOICE = frameWith({ vocalBody: 0.8, vocalAir: 0.8 });
/** 纯鼓点冲击：分离出的 kick/snare/hat + 整条 drums，不含任何人声/氛围轨。 */
const DRUM_ONLY = frameWith({ kick: 1, snare: 1, hat: 1, drums: 1 });

beforeEach(() => {
    resetEffectPulses();
    // 发声门控全开，免得歌词层效果的断言被 voiceGate 的底数干扰。
    musicVoicing.set(1);
});
afterEach(() => {
    resetEffectPulses();
    musicVoicing.set(0);
});

describe('effectPulses', () => {
    it('上升沿触发一次短脉冲，峰值沿用现有幅度、绝不超过 1', () => {
        const id = BEAT_EFFECT_IDS.classicPulseGlow;
        step(frameWith({}), 0);                 // 静息基线
        expect(readEffectTrack(id)).toBe(0);
        step(STEADY_VOICE, 0.016);              // 人声起来
        const peak = readEffectTrack(id);
        expect(peak).toBeGreaterThan(0.4);
        expect(peak).toBeLessThanOrEqual(1);
    });

    it('稳态不再重复触发，脉冲过后静息严格归零', () => {
        const id = BEAT_EFFECT_IDS.classicPulseGlow;
        step(frameWith({}), 0);
        step(STEADY_VOICE, 0.016);
        expect(readEffectTrack(id)).toBeGreaterThan(0.4);
        // 曲线保持高位（旧版会常年顶在峰值），这版应回落到 0。
        for (let t = 0.032; t <= 1.2; t += 0.016) step(STEADY_VOICE, t);
        expect(readEffectTrack(id)).toBe(0);
    });

    it('① 禁做名单里的效果恒 0，轨道再怎么起伏也不动', () => {
        step(frameWith({}), 0);
        step(frameWith({ vocalBody: 0.9, vocalAir: 0.9 }), 0.016);
        expect(readEffectTrack(BEAT_EFFECT_IDS.promptBoxFly)).toBe(0);
        expect(readEffectTrack(BEAT_EFFECT_IDS.promptTypePace)).toBe(0);
    });

    it('② 原生三样式不接语义轨脉冲：效果 id 已不再登记，读出来恒 0', () => {
        step(frameWith({}), 0);
        step(STEADY_VOICE, 0.016);
        // 这三条已随三样式退回上游、从 BEAT_EFFECT_IDS / EFFECT_TRACKS 摘除；
        // 用字面量读也只是懒创建的一条恒 0 MotionValue，不会被任何渲染层引用。
        expect(readEffectTrack('sonnet.lensTone')).toBe(0);
        expect(readEffectTrack('hanabi.chorusBloom')).toBe(0);
        expect(readEffectTrack('diorama.depthBreath')).toBe(0);
    });

    it('③ 关键回归：只来鼓点时，所有歌词/氛围效果恒 0 —— 不闪光弹、不整页震、不抖字', () => {
        const lyricAndAmbience = [
            BEAT_EFFECT_IDS.classicPulseGlow, BEAT_EFFECT_IDS.classicVocalShine,
            BEAT_EFFECT_IDS.cadenzaHaloBreath, BEAT_EFFECT_IDS.cadenzaScatterDrift,
            BEAT_EFFECT_IDS.cappellaVoicePop, BEAT_EFFECT_IDS.cappellaBubbleSway,
            BEAT_EFFECT_IDS.claddaghRingTilt, BEAT_EFFECT_IDS.claddaghBeadHop,
            BEAT_EFFECT_IDS.partitaStepTread, BEAT_EFFECT_IDS.partitaTierRise,
            BEAT_EFFECT_IDS.tiltLeanSway, BEAT_EFFECT_IDS.tiltMainReveal,
            BEAT_EFFECT_IDS.monetBrushBloom, BEAT_EFFECT_IDS.monetKeyGlow,
            BEAT_EFFECT_IDS.fumeInkWeight, BEAT_EFFECT_IDS.fumeVeilCalm,
            BEAT_EFFECT_IDS.lumiereBeamWidth, BEAT_EFFECT_IDS.lumiereLineSpark,
            BEAT_EFFECT_IDS.nebbiaFogDensity, BEAT_EFFECT_IDS.machiNeonGlow,
            BEAT_EFFECT_IDS.pendoloJewelGlow,
        ];
        step(frameWith({}), 0);
        for (let t = 0.016; t <= 0.6; t += 0.016) step(DRUM_ONLY, t);
        for (const id of lyricAndAmbience) {
            expect(readEffectTrack(id), id).toBe(0);
        }
    });

    it('背景效果不被分组误伤：自己的低频轨有上升沿就会脉冲', () => {
        step(frameWith({}), 0);
        step(frameWith({ bassSub: 0.9 }), 0.016);
        expect(readEffectTrack(BEAT_EFFECT_IDS.latentPulse)).toBeGreaterThan(0);
    });

    it('resetEffectPulses 清掉所有残留，切歌不留半截脉冲', () => {
        const id = BEAT_EFFECT_IDS.classicPulseGlow;
        step(frameWith({}), 0);
        step(STEADY_VOICE, 0.016);
        expect(readEffectTrack(id)).toBeGreaterThan(0);
        resetEffectPulses();
        expect(readEffectTrack(id)).toBe(0);
        expect(readEffectTrack(BEAT_EFFECT_IDS.latentPulse)).toBe(0);
    });
});
