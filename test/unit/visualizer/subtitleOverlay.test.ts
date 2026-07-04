import { describe, expect, it } from 'vitest';
import { resolveVisualizerSubtitleOverlayContent } from '@/components/visualizer/VisualizerSubtitleOverlay';
import type { Line } from '@/types';

// test/unit/visualizer/subtitleOverlay.test.ts
// Locks the split between hiding the whole subtitle overlay and hiding only translation text.

describe('VisualizerSubtitleOverlay content resolution', () => {
    const activeLine: Line = {
        startTime: 1,
        endTime: 2,
        fullText: 'Hello',
        translation: '你好',
        words: [],
    };
    const nextLine: Line = {
        startTime: 2,
        endTime: 3,
        fullText: 'World',
        words: [],
    };

    it('hides the entire overlay when the legacy hide setting is enabled', () => {
        const content = resolveVisualizerSubtitleOverlayContent({
            showText: true,
            activeLine,
            recentCompletedLine: null,
            nextLines: [nextLine],
            hideTranslationSubtitle: true,
            showSubtitleTranslation: true,
        });

        expect(content.shouldRenderOverlay).toBe(false);
        expect(content.translationText).toBeNull();
        expect(content.upcomingLines).toEqual([]);
    });

    it('keeps upcoming-line hints when only translation text is hidden', () => {
        const content = resolveVisualizerSubtitleOverlayContent({
            showText: true,
            activeLine,
            recentCompletedLine: null,
            nextLines: [nextLine],
            hideTranslationSubtitle: false,
            showSubtitleTranslation: false,
        });

        expect(content.shouldRenderOverlay).toBe(true);
        expect(content.translationText).toBeNull();
        expect(content.upcomingLines).toEqual([nextLine]);
    });
});
