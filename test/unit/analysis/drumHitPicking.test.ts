import { describe, expect, it } from 'vitest';

// test/unit/analysis/drumHitPicking.test.ts
// 混音路径的鼓点规整（drumHitPicking.ts `regularizeDrumHits`）：混音里贝斯与人声的起音
// 落在 kick / snare 的频带里，不收敛的话鼓面被敲得比拍点密好几倍 —— 用户听到的是
// 「鼓点和动感模式一个快一个慢」。规整后 body 起音回到基本脉冲上。

const { DRUM_HAT, DRUM_KICK, DRUM_SNARE, estimateDrumPulse, regularizeDrumHits } = await import('@/services/analysis/drumHitPicking');

const list = (rows: Array<[number, number, number]>) => ({
    times: Float64Array.from(rows.map(row => row[0])),
    strengths: Float32Array.from(rows.map(row => row[1])),
    kinds: Uint8Array.from(rows.map(row => row[2])),
});

const bodyTimes = (hits: { times: Float64Array; kinds: Uint8Array }) => {
    const out: number[] = [];
    for (let at = 0; at < hits.times.length; at += 1) {
        if (hits.kinds[at] !== DRUM_HAT) out.push(hits.times[at]);
    }
    return out;
};

describe('drum pulse', () => {
    it('reads the pulse off a steady kick, and gives nothing for noise', () => {
        const steady = Float64Array.from({ length: 12 }, (_, i) => 2 + i * 0.5);
        expect(estimateDrumPulse(steady, new Uint8Array(12).fill(DRUM_KICK))).toBeCloseTo(0.5, 2);
        // Irregular: no interval repeats, so no pulse.
        const noise = Float64Array.from([0, 0.21, 0.66, 0.9, 1.44, 1.7, 2.31, 2.5, 3.11]);
        expect(estimateDrumPulse(noise, new Uint8Array(noise.length).fill(DRUM_KICK))).toBeNull();
    });

    it('needs a few hits before it believes a number', () => {
        expect(estimateDrumPulse(Float64Array.from([0, 0.5, 1]), new Uint8Array(3).fill(DRUM_KICK))).toBeNull();
    });
});

describe('regularizing mix drum hits', () => {
    it('gathers a bass line\'s leaky onsets back onto the beat', () => {
        // 120 BPM. Real kicks on 0, 0.5, 1.0, 1.5 ...; the mix also rises at every 0.1 s
        // (bass notes, vowels), all of it in the kick band.
        const rows: Array<[number, number, number]> = [];
        for (let at = 0; at <= 40; at += 1) {
            const time = at * 0.1;
            const onBeat = Math.abs(time / 0.5 - Math.round(time / 0.5)) < 1e-6;
            rows.push([time, onBeat ? 0.95 : 0.35, DRUM_KICK]);
        }
        const shaped = regularizeDrumHits(list(rows));
        expect(shaped.times.length).toBeLessThan(rows.length / 2);
        // Every surviving body hit sits on the 0.5 s grid, to within a frame.
        for (const time of bodyTimes(shaped)) {
            expect(Math.abs(time / 0.5 - Math.round(time / 0.5))).toBeLessThan(0.02);
        }
        expect(bodyTimes(shaped).length).toBeGreaterThanOrEqual(8);
    });

    it('keeps a strong syncopation off the grid and drops a weak one', () => {
        const rows: Array<[number, number, number]> = [];
        for (let at = 0; at < 8; at += 1) rows.push([at * 0.5, 0.9, DRUM_KICK]);
        rows.push([2.25, 0.8, DRUM_SNARE]); // a real off-beat hit
        rows.push([3.1, 0.2, DRUM_SNARE]); // something leaking in
        const shaped = regularizeDrumHits(list(rows));
        const times = bodyTimes(shaped);
        expect(times.some(time => Math.abs(time - 2.25) < 1e-6)).toBe(true);
        expect(times.some(time => Math.abs(time - 3.1) < 1e-6)).toBe(false);
    });

    it('merges a kick and a snare landing on the same beat into one hit', () => {
        const rows: Array<[number, number, number]> = [];
        for (let at = 0; at < 6; at += 1) rows.push([at * 0.5, 0.7, DRUM_KICK]);
        rows.push([2.02, 0.9, DRUM_SNARE]);
        const shaped = regularizeDrumHits(list(rows));
        const near = bodyTimes(shaped).filter(time => Math.abs(time - 2) < 0.09);
        expect(near).toHaveLength(1);
        const index = Array.from(shaped.times).findIndex(time => Math.abs(time - 2) < 0.09);
        expect(shaped.strengths[index]).toBeCloseTo(0.9, 5);
        expect(shaped.kinds[index]).toBe(DRUM_SNARE);
    });

    it('thins hats but leaves them off the grid', () => {
        const rows: Array<[number, number, number]> = [];
        for (let at = 0; at < 20; at += 1) rows.push([at * 0.08, 0.5, DRUM_HAT]);
        const shaped = regularizeDrumHits({ ...list(rows), until: 2 });
        const hats = Array.from(shaped.kinds).filter(kind => kind === DRUM_HAT).length;
        expect(hats).toBeLessThanOrEqual(10);
        expect(hats).toBeGreaterThan(3);
        expect(shaped.until).toBe(2);
    });

    it('leaves a list it cannot read a pulse from alone but still thins repeats', () => {
        const rows: Array<[number, number, number]> = [
            [0.1, 0.4, DRUM_KICK], [0.16, 0.5, DRUM_KICK], [0.62, 0.6, DRUM_SNARE],
        ];
        const shaped = regularizeDrumHits(list(rows));
        expect(shaped.times.length).toBeLessThan(rows.length);
        expect(Array.from(shaped.times)).toEqual([...Array.from(shaped.times)].sort((a, b) => a - b));
    });
});
