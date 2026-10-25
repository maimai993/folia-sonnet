import { describe, expect, it } from 'vitest';
import { encodeDictBinary, encodeHmmBinary } from '../../../../dev/icuFolia/icuFoliaDataPlugin.mjs';
import { decodeJiebaDict, decodeJiebaHmm } from '../../../../src/utils/lyrics/icuFolia/jiebaData';

// test/unit/lyrics/icuFolia/jiebaData.test.ts
// Round-trips the binary formats jiebaData.ts decodes against the encoders the data plugin uses
// (dev/icuFolia/icuFoliaDataPlugin.mjs), on small hand-made inputs. The real dictionary runs
// through the same decode in jieba.test.ts, where the 500-sentence reference would catch any
// decoding slip that matters.

const HMM_STATES = ['B', 'E', 'M', 'S'] as const;

const readVarints = (bytes: Uint8Array): number[] => {
    const values: number[] = [];
    let value = 0;
    let scale = 1;
    for (const byte of bytes) {
        value += (byte & 0x7f) * scale;
        if (byte < 0x80) {
            values.push(value);
            value = 0;
            scale = 1;
        } else {
            scale *= 0x80;
        }
    }
    return values;
};

describe('the binary dict format', () => {
    it('round-trips words, frequencies and the total in code-unit order', () => {
        // 𠮷 (U+20BB7) sorts below 的 (U+7684) by code unit; the encoder trusts the caller's order
        // and the decode must preserve it. The frequencies cover one- and multi-byte varints.
        const words = ['𠮷野家', '的', '的话'];
        const freqs = [1, 128, 16451];
        const total = 3.5;

        const decoded = decodeJiebaDict(encodeDictBinary(words, freqs, total));

        expect(decoded.words.split('\n')).toEqual(words);
        expect(readVarints(decoded.freqs)).toEqual(freqs);
        expect(decoded.total).toBe(total);
    });

    it('round-trips an empty dictionary', () => {
        const decoded = decodeJiebaDict(encodeDictBinary([], [], 0));
        expect(decoded.words).toBe('');
        expect(decoded.freqs.length).toBe(0);
        expect(decoded.total).toBe(0);
    });
});

describe('the binary hmm format', () => {
    const meta = {
        start: { B: -0.6931471805599453, E: -0.51, M: -3.14e100, S: -1.2 },
        trans: { B: { E: -0.5 }, S: { B: -1.791759469228055 } },
        emit: {
            B: ['今AB𠮷', [-3.14e100, -0, 1e-300, 2.2250738585072014e-308]],
            E: ['天', [-0.0001]],
            M: ['𠮷', [Number.MAX_VALUE]],
            S: ['x', [-1.7976931348623157e308]],
        },
        t2s: '幾几發发',
    };

    it('round-trips start, transitions, emissions and the t2s pairs bit for bit', () => {
        const decoded = decodeJiebaHmm(encodeHmmBinary(meta));

        expect(decoded.start).toEqual(meta.start);
        expect(decoded.trans).toEqual(meta.trans);
        expect(decoded.t2s).toBe(meta.t2s);
        for (const state of HMM_STATES) {
            const [chars, logs] = decoded.emit[state];
            expect(chars).toBe(meta.emit[state][0]);
            expect(Array.from(logs)).toEqual(meta.emit[state][1]);
        }
    });

    it('decodes whichever way the JSON header lands on the 8-byte boundary', () => {
        // The plugin pads the header to an 8-byte boundary; a one-character difference in t2s
        // shifts the JSON length by one, so the two metas exercise both padding branches. A
        // misaligned payload would throw when the Float64Array view is built.
        const decoded = decodeJiebaHmm(encodeHmmBinary({ ...meta, t2s: 'x' }));
        const decodedAgain = decodeJiebaHmm(encodeHmmBinary({ ...meta, t2s: 'xy' }));

        for (const decodedBoth of [decoded, decodedAgain]) {
            expect(Array.from(decodedBoth.emit.S[1])).toEqual(meta.emit.S[1]);
        }
    });
});
