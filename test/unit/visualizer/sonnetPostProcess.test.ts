import { describe, expect, it } from 'vitest';
import { DEFAULT_SONNET_TUNING, type Theme } from '@/types';
import { resolveSonnetPostProcessProfile } from '@/components/visualizer/sonnet/sonnetPostProcess';

// test/unit/visualizer/sonnetPostProcess.test.ts
// Locks intensity-aware glow, disabled film noise, and static-mode filter suppression.
const theme = {
    animationIntensity: 'normal',
} as Theme;

describe('Sonnet post-process profile', () => {
    it('keeps glow restrained and film noise disabled', () => {
        const profile = resolveSonnetPostProcessProfile(theme, DEFAULT_SONNET_TUNING, false);

        expect(profile.glowStrength).toBeGreaterThan(3);
        expect(profile.glowAlpha).toBeLessThanOrEqual(0.62);
        expect(profile.noise).toBe(0);
    });

    it('disables filter passes in static mode', () => {
        expect(resolveSonnetPostProcessProfile(theme, DEFAULT_SONNET_TUNING, true))
            .toEqual({
                glowStrength: 0,
                glowAlpha: 0,
                noise: 0,
                contrast: 1,
                glitchIntensity: 0,
            });
    });

    it('scales with theme animation intensity without exceeding caps', () => {
        const calm = resolveSonnetPostProcessProfile(
            { ...theme, animationIntensity: 'calm' },
            DEFAULT_SONNET_TUNING,
            false,
        );
        const chaotic = resolveSonnetPostProcessProfile(
            { ...theme, animationIntensity: 'chaotic' },
            DEFAULT_SONNET_TUNING,
            false,
        );

        expect(chaotic.glowStrength).toBeGreaterThan(calm.glowStrength);
        expect(chaotic.glowAlpha).toBeLessThanOrEqual(0.62);
        expect(chaotic.noise).toBe(0);
    });
});
