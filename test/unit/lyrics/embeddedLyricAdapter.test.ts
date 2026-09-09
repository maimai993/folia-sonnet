import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddedLyricAdapter } from '@/utils/lyrics/adapters/EmbeddedLyricAdapter';
import { parseLyricsAsync } from '@/utils/lyrics/workerClient';

// test/unit/lyrics/embeddedLyricAdapter.test.ts
// Verifies embedded LX Music containers use the authoritative AWLRC tracks.

vi.mock('@/utils/lyrics/workerClient', () => ({
    parseLyricsAsync: vi.fn(),
}));

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('EmbeddedLyricAdapter', () => {
    beforeEach(() => {
        vi.mocked(parseLyricsAsync).mockReset();
        vi.mocked(parseLyricsAsync).mockResolvedValue({ lines: [] });
    });

    it('parses the AWLRC, translation, and romanization tracks from an embedded LX container', async () => {
        const awlrc = '[00:01.000]<0,500>原<500,500>文';
        const tlrc = '[00:01.000]translation';
        const rlrc = '[00:01.000]romanization';
        const fallbackBody = '[00:01.000]原文\n\n[00:01.000]translation';
        const container = `[awlrc:lrc:${encode(fallbackBody)},tlrc:${encode(tlrc)},rlrc:${encode(rlrc)},awlrc:${encode(awlrc)}]`;

        await new EmbeddedLyricAdapter().parse({
            type: 'embedded',
            textContent: `${fallbackBody}\n${container}`,
        });

        expect(parseLyricsAsync).toHaveBeenCalledWith('awlrc', awlrc, tlrc, {}, rlrc);
    });

    it('handles LX Music single-USLT frames with zho language and an empty descriptor', async () => {
        const awlrc = '[00:01.000]<0,500>原<500,500>文\n[00:03.000]<0,500>第<500,500>二句';
        const lrc = '[00:01.000]原文\n[00:03.000]第二句';
        const tlrc = '[00:01.000]translation\n[00:03.000]second translation';
        const rlrc = '[00:01.000]romanization\n[00:03.000]second romanization';
        const body = [lrc, tlrc, rlrc].join('\n\n');
        const container = `[awlrc:lrc:${encode(lrc)},tlrc:${encode(tlrc)},rlrc:${encode(rlrc)},awlrc:${encode(awlrc)}]`;

        await new EmbeddedLyricAdapter().parse({
            type: 'embedded',
            usltTags: [{ language: 'zho', descriptor: '', text: `${body}\n${container}` }],
        });

        expect(parseLyricsAsync).toHaveBeenCalledWith('awlrc', awlrc, tlrc, {}, rlrc);
    });
});
