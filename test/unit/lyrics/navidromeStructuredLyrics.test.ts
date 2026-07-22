import { describe, expect, it } from 'vitest';
import { parseNavidromeStructuredLyrics } from '@/utils/lyrics/navidromeStructuredLyrics';

// Covers OpenSubsonic songLyrics v2 cue timing emitted by Navidrome v0.63+.
describe('parseNavidromeStructuredLyrics', () => {
    it('preserves word timing instead of extending a line to the next lyric start', () => {
        const parsed = parseNavidromeStructuredLyrics({
            displayArtist: 'Artist',
            displayTitle: 'Track',
            line: [
                { start: 194652, value: 'Reviving each other in this hell' },
                { start: 219090, value: 'Lamenta lamenta lamenta' },
            ],
            synced: true,
            cueLine: [
                {
                    index: 0,
                    start: 194652,
                    end: 198132,
                    value: 'Reviving each other in this hell',
                    cue: [
                        { start: 194652, end: 195523, value: 'Reviving ' },
                        { start: 195523, end: 195909, value: 'each ' },
                        { start: 195909, end: 196587, value: 'other ' },
                        { start: 196587, end: 197078, value: 'in ' },
                        { start: 197078, end: 197540, value: 'this ' },
                        { start: 197540, end: 198132, value: 'hell' },
                    ],
                },
                {
                    index: 1,
                    start: 219090,
                    end: 219630,
                    value: 'Lamenta lamenta lamenta',
                    cue: [
                        { start: 219090, end: 219260, value: 'Lamenta ' },
                        { start: 219260, end: 219451, value: 'lamenta ' },
                        { start: 219451, end: 219630, value: 'lamenta' },
                    ],
                },
            ],
        }, { includeInterludes: false });

        expect(parsed?.title).toBe('Track');
        expect(parsed?.lines[0]).toMatchObject({
            startTime: 194.652,
            endTime: 198.132,
            fullText: 'Reviving each other in this hell',
        });
        expect(parsed?.lines[0].words).toEqual([
            { text: 'Reviving ', startTime: 194.652, endTime: 195.523 },
            { text: 'each ', startTime: 195.523, endTime: 195.909 },
            { text: 'other ', startTime: 195.909, endTime: 196.587 },
            { text: 'in ', startTime: 196.587, endTime: 197.078 },
            { text: 'this ', startTime: 197.078, endTime: 197.54 },
            { text: 'hell', startTime: 197.54, endTime: 198.132 },
        ]);
    });
});
