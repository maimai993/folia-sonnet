export type TimedLyricFormat = 'lrc' | 'enhanced-lrc' | 'vtt';

const VTT_TIMING_LINE_REGEX = /(?:^|\n)\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/m;
const ENHANCED_LRC_ANGLE_REGEX = /<\d{2}:\d{2}[.:]\d{2,3}>/;
const ENHANCED_LRC_INLINE_BRACKET_REGEX = /(?:^|\n)\s*\[\d{2}:\d{2}[.:]\d{2,3}\][^\[\]\n]+(?:\[\d{2}:\d{2}[.:]\d{2,3}\][^\[\]\n]*)+/m;

export function detectTimedLyricFormat(content?: string): TimedLyricFormat {
    const normalized = content?.replace(/^\uFEFF/, '').trim() || '';

    if (
        normalized.startsWith('WEBVTT') ||
        normalized.includes('-->') ||
        VTT_TIMING_LINE_REGEX.test(normalized)
    ) {
        return 'vtt';
    }

    if (
        ENHANCED_LRC_ANGLE_REGEX.test(normalized) ||
        ENHANCED_LRC_INLINE_BRACKET_REGEX.test(normalized)
    ) {
        return 'enhanced-lrc';
    }

    return 'lrc';
}
