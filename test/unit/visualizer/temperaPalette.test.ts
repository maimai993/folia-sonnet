import { describe, expect, it } from 'vitest';
import type { Theme } from '@/types';
import { parseColorChannels } from '@/components/visualizer/colorMix';
import { resolveTemperaPalette } from '@/components/visualizer/tempera/temperaPalette';

// test/unit/visualizer/temperaPalette.test.ts
// Locks palette determinism, mono grayscale purity, and ink/paper contrast guarantees.
const theme = (overrides: Partial<Theme>): Theme => ({
    backgroundColor: '#101014',
    primaryColor: '#f2f2f0',
    accentColor: '#e1565f',
    secondaryColor: '#4f7fb8',
    ...overrides,
} as Theme);

const channelsOf = (color: string) => {
    const channels = parseColorChannels(color);
    expect(channels).not.toBeNull();
    return channels!;
};

describe('Tempera palette', () => {
    it('is deterministic for the same theme and color mode', () => {
        const input = theme({});
        expect(resolveTemperaPalette(input, { colorMode: 'duo' }))
            .toEqual(resolveTemperaPalette(input, { colorMode: 'duo' }));
        expect(resolveTemperaPalette(input, { colorMode: 'mono' }))
            .toEqual(resolveTemperaPalette(input, { colorMode: 'mono' }));
    });

    it('derives duo blocks from theme hues rather than grayscale', () => {
        const palette = resolveTemperaPalette(theme({}), { colorMode: 'duo' });
        const blockA = channelsOf(palette.blockA);
        const blockB = channelsOf(palette.blockB);
        // Hue-carrying mixes must not collapse to r === g === b.
        expect(new Set([blockA.r, blockA.g, blockA.b]).size).toBeGreaterThan(1);
        expect(new Set([blockB.r, blockB.g, blockB.b]).size).toBeGreaterThan(1);
        expect(palette.accent).toBe('#e1565f');
    });

    it('collapses every mono step to a true grayscale ladder', () => {
        const palette = resolveTemperaPalette(theme({ accentColor: '#ff2200' }), { colorMode: 'mono' });
        [palette.paper, palette.ink, palette.blockA, palette.blockB, palette.blockC, palette.accent]
            .forEach(color => {
                const { r, g, b } = channelsOf(color);
                expect(r).toBe(g);
                expect(g).toBe(b);
            });
        // The ladder stays ordered from paper toward ink.
        const paperL = channelsOf(palette.paper).r;
        const inkL = channelsOf(palette.ink).r;
        const steps = [palette.blockA, palette.blockB, palette.blockC].map(color => channelsOf(color).r);
        steps.forEach(step => {
            expect(step).toBeGreaterThanOrEqual(Math.min(paperL, inkL));
            expect(step).toBeLessThanOrEqual(Math.max(paperL, inkL));
        });
    });

    it('forces legible mono contrast when the themed ink is a mid-tone color', () => {
        const palette = resolveTemperaPalette(theme({
            backgroundColor: '#202020',
            primaryColor: '#7a7a7a',
        }), { colorMode: 'mono' });
        const paperL = channelsOf(palette.paper).r;
        const inkL = channelsOf(palette.ink).r;
        expect(Math.abs(inkL - paperL)).toBeGreaterThanOrEqual(96);
    });

    it('keeps duo anchored to the themed paper and ink', () => {
        const palette = resolveTemperaPalette(theme({}), { colorMode: 'duo' });
        expect(palette.paper).toBe('#101014');
        expect(palette.ink).toBe('#f2f2f0');
    });
});
