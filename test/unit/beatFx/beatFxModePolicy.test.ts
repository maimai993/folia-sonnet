import { describe, expect, it } from 'vitest';
import {
    NATIVE_BEAT_MODES,
    NO_SMART_BEAT_MODES,
    effectMode,
    modeHasSmartBeat,
    modeIsForbidden,
} from '../../../src/services/beatFx/beatFxModePolicy';

// 智能动感的分组接线（2026-11 定稿）是唯一事实来源。这次改成「分别改接口和调」：
//   · 花火 / 商籁 / 镜台走原生 beatImpact 推镜震动，不接语义轨脉冲系统；
//   · 其余样式接语义轨脉冲，但一律不叠鼓点（不再有「接鼓点振动」这一档）；
//   · 纯文字/静态 + 模组样式完全不做。
// 这张表一错就是「提示词还在动」「莫奈整页跟着鼓抖」「花火没震动」这类整机级偏差。

const NO_SMART = ['prompt', 'kinetic', 'still'] as const;
const NATIVE = ['sonnet', 'hanabi', 'diorama'] as const;
// 其余歌词样式：做智能动感，但不接鼓点。
const SMART = [
    'classic', 'cadenza', 'cappella', 'claddagh', 'fume', 'lumiere',
    'machi', 'monet', 'nebbia', 'partita', 'pendolo', 'tempera', 'tilt',
] as const;

describe('beatFxModePolicy', () => {
    it('① 完全不做的三个样式 + 全部模组样式：不做动感、被判禁做', () => {
        for (const mode of [...NO_SMART, 'mod:visualizer-jump', 'mod:vinyl-disc']) {
            expect(modeHasSmartBeat(mode), mode).toBe(false);
            expect(modeIsForbidden(mode), mode).toBe(true);
        }
    });

    it('② 花火/商籁/镜台：走原生 beatImpact 震动，不接语义轨脉冲，也不再新增效果', () => {
        for (const mode of NATIVE) {
            expect(modeHasSmartBeat(mode), mode).toBe(false);
            expect(modeIsForbidden(mode), mode).toBe(true);
            expect(NATIVE_BEAT_MODES.has(mode), mode).toBe(true);
        }
    });

    it('③ 其余样式：有智能动感、不被判禁做（且没有任何一个接鼓点振动）', () => {
        for (const mode of SMART) {
            expect(modeHasSmartBeat(mode), mode).toBe(true);
            expect(modeIsForbidden(mode), mode).toBe(false);
            // 关键回归：旧分组里的「接鼓点振动」名单已彻底取消，任何样式都不再接鼓点。
            expect(NATIVE_BEAT_MODES.has(mode), mode).toBe(false);
        }
    });

    it('两张名单两两不重叠，且名单与函数判定一致', () => {
        for (const mode of NO_SMART_BEAT_MODES) expect(NATIVE_BEAT_MODES.has(mode), mode).toBe(false);
        for (const mode of NATIVE_BEAT_MODES) expect(NO_SMART_BEAT_MODES.has(mode), mode).toBe(false);
        for (const mode of NO_SMART_BEAT_MODES) expect(modeHasSmartBeat(mode), mode).toBe(false);
        for (const mode of NATIVE_BEAT_MODES) expect(modeHasSmartBeat(mode), mode).toBe(false);
    });

    it('背景效果不被「不在白名单就关」误伤', () => {
        // latent.pulse 是背景层的驱动，不属于任何歌词样式；恒 0 会让背景彻底静止。
        expect(modeHasSmartBeat('latent')).toBe(true);
        expect(modeIsForbidden('latent')).toBe(false);
        // 以后新加的样式也不该被白名单误杀。
        expect(modeHasSmartBeat('a-new-style')).toBe(true);
        expect(modeIsForbidden('a-new-style')).toBe(false);
    });

    it('effectMode 从 <mode>.<name> 取出 mode', () => {
        expect(effectMode('classic.pulseGlow')).toBe('classic');
        expect(effectMode('latent.pulse')).toBe('latent');
        expect(effectMode('noDot')).toBe('noDot');
    });
});
