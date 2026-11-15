import { describe, expect, it } from 'vitest';
import { detectKey, type MusicEnvelope } from '../../../src/services/analysis/musicEnvelope';

// 调性检测是「整曲色度 → 24 条轮廓里挑一条」的纯函数。它只有两个容易写错的地方：
// 根音编号（A=440 起算还是 C 起算）和大小调的先后。这两处错了，画面上就是
// 「色温跟着一首歌永远偏三个半音」，听不出来、但一眼看着不对。

const envelopeOf = (chroma: number[]): MusicEnvelope => {
    const sum = chroma.reduce((acc, value) => acc + value, 0);
    return {
        fps: 25,
        chromaMean: Float32Array.from(chroma.map(value => value / sum)),
    } as unknown as MusicEnvelope;
};

/** C 大调音阶里各音级的相对权重：主音最重，属音、中音次之。 */
const C_MAJOR = [1.0, 0.02, 0.45, 0.02, 0.8, 0.35, 0.02, 0.7, 0.02, 0.25, 0.02, 0.1];
/** A 小调：主音是 A（9 号），中音 C、属音 E 跟着重。 */
const A_MINOR = [0.7, 0.02, 0.02, 0.02, 0.6, 0.02, 0.02, 0.45, 0.02, 1.0, 0.02, 0.3];
/** G 大调：主音 G（7 号），三音 B（11），五音 D（2）。 */
const G_MAJOR = [0.02, 0.02, 0.6, 0.02, 0.02, 0.3, 0.02, 1.0, 0.02, 0.02, 0.02, 0.7];

describe('detectKey', () => {
    it('C 大调判成 C 大调', () => {
        const key = detectKey(envelopeOf(C_MAJOR));
        expect(key).not.toBeNull();
        expect(key?.root).toBe(0);
        expect(key?.minor).toBe(false);
    });

    it('A 小调判成 A 小调', () => {
        const key = detectKey(envelopeOf(A_MINOR));
        expect(key).not.toBeNull();
        expect(key?.root).toBe(9);
        expect(key?.minor).toBe(true);
    });

    it('G 大调判成 G 大调', () => {
        const key = detectKey(envelopeOf(G_MAJOR));
        expect(key).not.toBeNull();
        expect(key?.root).toBe(7);
        expect(key?.minor).toBe(false);
    });

    it('没有色度就没有调性', () => {
        expect(detectKey({ fps: 25 } as unknown as MusicEnvelope)).toBeNull();
        expect(detectKey(envelopeOf(new Array(12).fill(0)))).toBeNull();
    });

    it('同一份包络只算一次（结果是缓存的）', () => {
        const envelope = envelopeOf(C_MAJOR);
        const first = detectKey(envelope);
        const second = detectKey(envelope);
        expect(second).toBe(first);
    });
});
