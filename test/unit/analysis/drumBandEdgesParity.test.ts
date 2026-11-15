import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { melBandCentresHz, MEL_BANDS } from '@/services/analysis/beatThis';
import { HAT_MIN_HZ, KICK_MAX_HZ, SNARE_MAX_HZ, drumBandTracks } from '@/services/analysis/drumHitPicking';

// test/unit/analysis/drumBandEdgesParity.test.ts
// Web 与 Android 对「同一首歌的三条鼓点频带」必须划得一样（#344）。Kotlin 单测不进 CI，
// 所以这里在 CI 里守住：读 Android 源码里的边界常量与 mel 参数，与 Web 的实现逐项对账，
// 并把 Web 的 mel 中心频率与各带归属钉死 —— 两边任何一边单独改了都会红。

const javaRoot = new URL('../../../android/app/src/main/java/top/izuna/foliamajor/automix/', import.meta.url);
const edgesKt = readFileSync(new URL('DrumBandEdges.kt', javaRoot), 'utf8');
const runnerKt = readFileSync(new URL('BeatThisRunner.kt', javaRoot), 'utf8');

const kotlinNumber = (source: string, name: string): number => {
    const match = new RegExp(`const val ${name}\\s*=\\s*([0-9_.]+)`).exec(source);
    if (!match) throw new Error(`没有在 Kotlin 源码里找到 ${name}`);
    return Number(match[1].replaceAll('_', ''));
};

describe('drum band edges: Web and Android agree', () => {
    it('uses the same three boundaries', () => {
        expect(kotlinNumber(edgesKt, 'KICK_MAX_HZ')).toBe(KICK_MAX_HZ);
        expect(kotlinNumber(edgesKt, 'SNARE_MAX_HZ')).toBe(SNARE_MAX_HZ);
        expect(kotlinNumber(edgesKt, 'HAT_MIN_HZ')).toBe(HAT_MIN_HZ);
    });

    it('leaves the same gap between snare and hat', () => {
        expect(HAT_MIN_HZ).toBeGreaterThan(SNARE_MAX_HZ);
    });

    it('feeds the model the same mel parameters on both sides', () => {
        expect(kotlinNumber(runnerKt, 'N_MELS')).toBe(MEL_BANDS);
        expect(kotlinNumber(runnerKt, 'F_MIN')).toBe(30);
        expect(kotlinNumber(runnerKt, 'F_MAX')).toBe(11000);
    });

    // 下面这组数值与 android DrumBandEdgesTest 里写死的基准是同一份：Web 这边是它们的出处。
    it('pins the mel band centres the Kotlin test checks against', () => {
        const centres = melBandCentresHz();
        expect(centres).toHaveLength(128);
        expect(centres[0]).toBeCloseTo(55.54396640387823, 9);
        expect(centres[64]).toBeCloseTo(2037.9612153053977, 9);
        expect(centres[100]).toBeCloseTo(5260.85822394576, 9);
        expect(centres[127]).toBeCloseTo(10714.011559875331, 9);
    });

    it('pins which mel bands each drum band takes, including the 4-6 kHz gap', () => {
        const centres = melBandCentresHz();
        const pick = (from: number, to: number) => centres.map((hz, i) => (hz >= from && hz < to ? i : -1)).filter(i => i >= 0);
        const range = (list: number[]) => [list[0], list[list.length - 1], list.length];
        expect(range(pick(0, KICK_MAX_HZ))).toEqual([0, 3, 4]);
        expect(range(pick(KICK_MAX_HZ, SNARE_MAX_HZ))).toEqual([4, 89, 86]);
        expect(range(pick(HAT_MIN_HZ, Infinity))).toEqual([105, 127, 23]);
        expect(range(pick(SNARE_MAX_HZ, HAT_MIN_HZ))).toEqual([90, 104, 15]);
    });

    it('drumBandTracks puts a 5 kHz band in no drum band and an 8 kHz band in hat', () => {
        const centres = melBandCentresHz();
        const frames = 4;
        const energise = (band: number) => {
            const data = new Float32Array(frames * MEL_BANDS);
            for (let frame = 0; frame < frames; frame += 1) data[frame * MEL_BANDS + band] = 1;
            return { data, frames, bands: MEL_BANDS } as never;
        };
        const nearest = (hz: number) => centres.reduce((best, value, index) => (Math.abs(value - hz) < Math.abs(centres[best] - hz) ? index : best), 0);
        const at5k = drumBandTracks(energise(nearest(5000)));
        const at8k = drumBandTracks(energise(nearest(8000)));
        expect(at5k.map(track => Math.max(...track))).toEqual([0, 0, 0]);
        expect(Math.max(...at8k[2])).toBeGreaterThan(0);
        expect(Math.max(...at8k[0], ...at8k[1])).toBe(0);
    });
});
