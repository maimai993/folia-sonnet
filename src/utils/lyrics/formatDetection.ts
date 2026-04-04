export type TimedLyricFormat = 'lrc' | 'vtt';

const VTT_TIMING_LINE_REGEX = /(?:^|\n)\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/m;

export function detectTimedLyricFormat(content?: string): TimedLyricFormat {
    const normalized = content?.replace(/^\uFEFF/, '').trim() || '';

    if (
        normalized.startsWith('WEBVTT') ||
        normalized.includes('-->') ||
        VTT_TIMING_LINE_REGEX.test(normalized)
    ) {
        return 'vtt';
    }

    return 'lrc';
}
