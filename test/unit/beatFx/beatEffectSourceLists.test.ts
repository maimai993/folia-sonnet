// test/unit/beatFx/beatEffectSourceLists.test.ts
// 防漂移：DRUM_BEAT_EFFECT_IDS / ENVELOPE_BEAT_EFFECT_IDS 是手抄的「哪些效果吃哪路数据」。
// 样式 entry.tsx 才是真正的声明处 —— 这里锁死两边一致：哪个样式新加了鼓点/包络效果，
// 忘了补手抄列表，这个测试就红，而不是等真机上「鼓点效果概率不生效」才发现。

import { describe, expect, it } from 'vitest';
import { VISUALIZER_REGISTRY } from '@/components/visualizer/registry';
import {
    DRUM_BEAT_EFFECT_IDS,
    ENVELOPE_BEAT_EFFECT_IDS,
    offeredBeatEffects,
} from '@/services/beatFx/beatEffects';

const collectBySource = (source: 'drums' | 'envelopes'): string[] => {
    const ids = new Set<string>();
    for (const entry of VISUALIZER_REGISTRY) {
        for (const effect of offeredBeatEffects(entry.beatEffects)) {
            if (effect.source === source) ids.add(effect.id);
        }
    }
    return [...ids].sort();
};

describe('动感效果的数据源列表与样式注册表一致', () => {
    it('每个 drums 效果都在 DRUM_BEAT_EFFECT_IDS 里', () => {
        const listed = new Set(DRUM_BEAT_EFFECT_IDS);
        const missing = collectBySource('drums').filter(id => !listed.has(id));
        expect(missing).toEqual([]);
    });

    it('每个 envelopes 效果都在 ENVELOPE_BEAT_EFFECT_IDS 里', () => {
        const listed = new Set(ENVELOPE_BEAT_EFFECT_IDS);
        const missing = collectBySource('envelopes').filter(id => !listed.has(id));
        expect(missing).toEqual([]);
    });
});
