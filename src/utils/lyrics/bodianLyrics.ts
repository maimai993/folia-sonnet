import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseAwlrc, parseLyricsByFormat } from './parserCore';
import { isPureMusicLyricText } from './pureMusic';

// src/utils/lyrics/bodianLyrics.ts

// [kuwo:127] encodes decimal factors 8 and 7 in octal. They vary between lyric files.
export function decodeBodianWordTiming(content: string): string | null {
    const tag = content.match(/\[kuwo:([0-7]+)(?:\]\[.*)?\]/);
    const factors = tag ? parseInt(tag[1], 8) : 11;
    const startFactor = Math.trunc(factors / 10);
    const durationFactor = factors % 10;
    if (!startFactor || !durationFactor) return null;
    return content.replace(/\[kuwo:[^\]]*\]/g, '').replace(
        /<(-?\d+),(-?\d+)>/g,
        (_match, left, right) => {
            const a = Number(left), b = Number(right);
            const start = Math.trunc(Math.abs((a + b) / (2 * startFactor)));
            const duration = Math.trunc(Math.abs((a - b) / (2 * durationFactor)));
            return `<${start},${duration}>`;
        },
    );
}

export function parseBodianLyrics(content: string): ProviderLyricsResult {
    const mainText = content.replace(/<-?\d+,-?\d+>/g, '');
    const hasWords = /<-?\d+,-?\d+>/.test(content);
    const decoded = hasWords ? decodeBodianWordTiming(content) : null;
    const wordLyrics = decoded ? parseAwlrc(decoded) : null;
    const lyrics = wordLyrics?.lines.length ? wordLyrics : parseLyricsByFormat('lrc', mainText);
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText, wordByWordText: wordLyrics?.lines.length ? decoded : undefined,
        isPureMusic: isPureMusicLyricText(mainText),
    };
}
