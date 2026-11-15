import { describe, expect, it } from 'vitest';
import { BEAT_EFFECT_IDS } from '../../../src/services/beatFx/beatEffects';
import { EFFECT_TRACKS, effectTrackMix } from '../../../src/services/beatFx/effectTracks';

// 这张表是「每个效果只读自己需要的音轨」的唯一事实来源。这次「分别改接口和调」之后，
// 三个不变量必须一直成立，否则「整页跟鼓抖 / 闪光弹 / 歌词左右抖」会悄悄回来：
//   1. 表里**没有任何鼓轨**（drums / kick / snare / hat）—— 整页鼓点震动只属于
//      花火/商籁/镜台的 beatImpact 原生路径，语义轨脉冲系统一律不碰鼓；
//   2. 歌词层 / 氛围层效果连低频（bass / bassSub）都不读，只跟人声、和声、氛围、亮度；
//   3. 花火/商籁/镜台的效果**不在表里** —— 它们已退回上游原始读取实现。

const DRUM_TRACKS = ['drums', 'kick', 'snare', 'hat'] as const;
const LOW_TRACKS = ['bass', 'bassSub'] as const;
/** 背景效果单独留的低频脉动，不属于任何歌词样式。 */
const BACKGROUND_EFFECTS = [BEAT_EFFECT_IDS.latentPulse] as const;

describe('effectTracks', () => {
    it('每份权重都为正，且加起来不超过 1.35（超过会把归一的曲线顶成常量）', () => {
        for (const [id, mix] of Object.entries(EFFECT_TRACKS)) {
            const total = Object.values(mix).reduce((sum, weight) => sum + weight, 0);
            expect(total, id).toBeGreaterThan(0);
            expect(total, id).toBeLessThanOrEqual(1.35);
            for (const weight of Object.values(mix)) expect(weight, id).toBeGreaterThan(0);
        }
    });

    it('关键回归：登记的效果一个都不读鼓轨 —— 不会有跟鼓点一闪一闪的闪光弹', () => {
        for (const [id, mix] of Object.entries(EFFECT_TRACKS)) {
            const tracks = Object.keys(mix);
            for (const drum of DRUM_TRACKS) expect(tracks, `${id} 不该读 ${drum}`).not.toContain(drum);
        }
    });

    it('歌词 / 氛围效果连低频都不读，只跟人声、和声、氛围、亮度', () => {
        for (const [id, mix] of Object.entries(EFFECT_TRACKS)) {
            if ((BACKGROUND_EFFECTS as readonly string[]).includes(id)) continue;
            const tracks = Object.keys(mix);
            for (const low of LOW_TRACKS) expect(tracks, `${id} 不该读 ${low}`).not.toContain(low);
        }
    });

    it('花火/商籁/镜台走原生 beatImpact 路径，其效果不进这张表', () => {
        const ids = Object.keys(EFFECT_TRACKS);
        for (const id of ids) {
            expect(id.startsWith('sonnet.'), id).toBe(false);
            expect(id.startsWith('hanabi.'), id).toBe(false);
            expect(id.startsWith('diorama.'), id).toBe(false);
        }
    });

    it('背景效果保留自己的低频脉动，不被误伤', () => {
        expect(Object.keys(effectTrackMix(BEAT_EFFECT_IDS.latentPulse))).toContain('bassSub');
    });

    it('没登记的效果退到伴奏总线，不会退到含鼓的线', () => {
        const fallback = effectTrackMix('not.registered');
        expect(Object.keys(fallback)).toEqual(['harmony']);
    });
});
