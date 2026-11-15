import { describe, expect, it } from 'vitest';
import { BUILTIN_VISUALIZER_MODES } from '@/types/visualizerModes';

/*
 * 随机池里没有 `blank`。
 *
 * 它一个歌词都不画，随机到它读起来是「样式坏了」，而不是「换了个样式」；
 * 真想要的人会自己选。所以这里按「内建减去 blank」比对。
 */
const RANDOM_ELIGIBLE_MODES = BUILTIN_VISUALIZER_MODES.filter(mode => mode !== 'blank');
import { normalizeRandomVisualizerModes, pickRandomVisualizerMode } from '@/utils/randomVisualizerModes';

// The random pool accepts built-ins only and never becomes empty or repeats an avoidable choice.
describe('random visualizer pool', () => {
    it.each([undefined, null, [], {}, 'classic', ['unknown', 'mod:test:style']])('defaults an unusable pool to all built-ins: %j', value => {
        expect(normalizeRandomVisualizerModes(value)).toEqual(RANDOM_ELIGIBLE_MODES);
    });

    it('removes unknown modes, mod modes and duplicates without weighting repeated ids', () => {
        expect(normalizeRandomVisualizerModes(['tilt', 'classic', 'tilt', 'mod:test:style', 123]))
            .toEqual(['classic', 'tilt']);
    });

    it('picks only selected styles, with no consecutive repeat when alternatives exist', () => {
        for (const current of ['classic', 'sonnet', 'tilt', 'monet']) {
            for (const value of [0, 0.25, 0.5, 0.999999]) {
                const next = pickRandomVisualizerMode(['sonnet', 'tilt'], current, () => value);
                expect(['sonnet', 'tilt']).toContain(next);
                expect(next).not.toBe(current);
            }
        }
    });

    it('keeps the sole selected style, even when it is already current', () => {
        expect(pickRandomVisualizerMode(['still'], 'still')).toBe('still');
        expect(pickRandomVisualizerMode(['still'], 'classic')).toBe('still');
    });

    it('gives every eligible built-in a chance with all selected', () => {
        const sampled = RANDOM_ELIGIBLE_MODES.map((_, index) => (
            pickRandomVisualizerMode(RANDOM_ELIGIBLE_MODES, 'mod:current', () => index / RANDOM_ELIGIBLE_MODES.length)
        ));
        expect(sampled).toEqual(RANDOM_ELIGIBLE_MODES);
    });

    it('still honours blank when the pool names it outright', () => {
        // 排除只作用于「默认池」；用户自己把空样式放进池子就是要它，照给。
        expect(pickRandomVisualizerMode(['blank'], 'classic', () => 0)).toBe('blank');
    });
});
