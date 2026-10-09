import i18n from '../i18n/config';
import type { LyricData, ReplayGainMode, SongResult } from '../types';
import type { StructuredLyric } from '../types/navidrome';
import { detectTimedLyricFormat } from './lyrics/formatDetection';
import { getLineRenderHints } from './lyrics/renderHints';
import { isLocalPlaybackSong, isNavidromePlaybackSong, isStagePlaybackSong } from './appPlaybackGuards';

export { hasRenderableLyrics } from './lyrics/validity';

// Pure helpers for playback state, debug snapshots, and lyric timing.
export const clampMediaVolume = (value: number) => Math.min(1, Math.max(0, value));

export const extractCloudLyricText = (response: any): string => {
    if (typeof response?.lrc === 'string') return response.lrc;
    if (typeof response?.data?.lrc === 'string') return response.data.lrc;
    if (typeof response?.lyric === 'string') return response.lyric;
    if (typeof response?.data?.lyric === 'string') return response.data.lyric;
    return '';
};

type LyricLines = LyricData['lines'];

type LineIndexCacheEntry = {
    length: number;
    starts: Float64Array;
    renderEnds: Float64Array;
    monotonic: boolean;
};

// Lines arrays are rebuilt (not mutated in place) whenever render hints migrate, so caching the
// timing arrays per lines-array identity is safe and only costs one O(n) pass per song.
const lineIndexCache = new WeakMap<LyricLines, LineIndexCacheEntry>();

const resolveEffectiveRenderEnd = (line: LyricLines[number]): number =>
    line.renderHints?.renderEndTime ?? line.endTime;

const getLineIndexCache = (lines: LyricLines): LineIndexCacheEntry | null => {
    const cached = lineIndexCache.get(lines);
    if (cached && cached.length === lines.length) {
        return cached;
    }

    if (lines.length === 0) {
        return null;
    }

    const starts = new Float64Array(lines.length);
    const renderEnds = new Float64Array(lines.length);
    let monotonic = true;
    let previousStart = Number.NEGATIVE_INFINITY;
    let previousRenderEnd = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) {
            monotonic = false;
            break;
        }
        const start = line.startTime;
        const renderEnd = resolveEffectiveRenderEnd(line);
        if (start < previousStart || renderEnd < previousRenderEnd || start > renderEnd) {
            monotonic = false;
            break;
        }
        previousStart = start;
        previousRenderEnd = renderEnd;
        starts[index] = start;
        renderEnds[index] = renderEnd;
    }

    const entry: LineIndexCacheEntry = { length: lines.length, starts, renderEnds, monotonic };
    lineIndexCache.set(lines, entry);
    return entry;
};

const findLatestActiveLineIndexLinear = (lines: LyricLines, time: number) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || time < line.startTime) {
            continue;
        }
        if (time <= (line.renderHints?.renderEndTime ?? line.endTime)) {
            return index;
        }
    }
    return -1;
};

// Finds the highest line index whose [startTime, renderEndTime] window contains `time`.
// The linear scan walks the whole array during inter-line gaps, which this runs at 60fps,
// so for the (overwhelmingly common) monotonic case we binary-search a cached timing table.
export const findLatestActiveLineIndex = (lines: LyricLines, time: number) => {
    if (lines.length < 8) {
        return findLatestActiveLineIndexLinear(lines, time);
    }

    const cache = getLineIndexCache(lines);
    if (!cache || !cache.monotonic) {
        return findLatestActiveLineIndexLinear(lines, time);
    }

    const { starts, renderEnds } = cache;

    // lastStarted = last index with startTime <= time.
    let low = 0;
    let high = starts.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (starts[mid] <= time) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    const lastStarted = low - 1;
    if (lastStarted < 0) {
        return -1;
    }

    // firstCovered = first index with renderEnd >= time.
    low = 0;
    high = renderEnds.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (renderEnds[mid] >= time) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    // The answer is the largest index satisfying both bounds.
    return lastStarted >= low ? lastStarted : -1;
};

export const formatTime = (time: number) => {
    if (isNaN(time)) return '00:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

export const getReplayGainModeLabel = (mode: ReplayGainMode): string => i18n.t(`replayGain.${mode}`);

export const getAudioSrcKind = (audioSrc: string | null): 'empty' | 'blob' | 'http' | 'other' => {
    if (!audioSrc) {
        return 'empty';
    }

    if (audioSrc.startsWith('blob:')) {
        return 'blob';
    }

    if (audioSrc.startsWith('http://') || audioSrc.startsWith('https://')) {
        return 'http';
    }

    return 'other';
};

export const toSafeRemoteUrl = (url: string | null | undefined): string | null | undefined => {
    if (!url) {
        return url;
    }

    const normalizedUrl = url.split(/,\s*(?=https?:\/\/)/i)[0]?.trim() || url;

    if (normalizedUrl.startsWith('http:') && normalizedUrl.includes('music.126.net')) {
        return normalizedUrl.replace('http:', 'https:');
    }

    try {
        const parsedUrl = new URL(normalizedUrl);
        if (
            parsedUrl.protocol === 'http:' &&
            parsedUrl.hostname.startsWith('fs.') &&
            parsedUrl.hostname.endsWith('.kugou.com')
        ) {
            return normalizedUrl.replace(/^http:/, 'https:');
        }
    } catch {
        return normalizedUrl;
    }

    return normalizedUrl;
};

// Keeps KuGou's original HTTP media URL only in Electron; Web/PWA retains HTTPS normalization.
export const toSafePlaybackUrl = (
    url: string | null | undefined,
    isElectron = typeof window !== 'undefined' && Boolean(window.electron)
): string | null | undefined => {
    if (!url || !isElectron) {
        return toSafeRemoteUrl(url);
    }

    const normalizedUrl = url.split(/,\s*(?=https?:\/\/)/i)[0]?.trim() || url;
    try {
        const parsedUrl = new URL(normalizedUrl);
        if (
            parsedUrl.protocol === 'http:' &&
            parsedUrl.hostname.startsWith('fs.') &&
            parsedUrl.hostname.endsWith('.kugou.com')
        ) {
            return normalizedUrl;
        }
    } catch {
        return normalizedUrl;
    }

    return toSafeRemoteUrl(normalizedUrl);
};

export const resolveDebugSongSource = (song: SongResult | null): 'none' | 'local' | 'navidrome' | 'online' => {
    if (isStagePlaybackSong(song)) {
        return 'online';
    }

    if (isLocalPlaybackSong(song)) {
        return 'local';
    }

    if (isNavidromePlaybackSong(song)) {
        return 'navidrome';
    }

    return song ? 'online' : 'none';
};

export const resolveDebugLyricsSource = (
    song: SongResult | null,
    lyrics: LyricData | null
): 'none' | 'local' | 'embedded' | 'online' | 'navi' => {
    if (isStagePlaybackSong(song)) {
        return lyrics ? 'local' : 'none';
    }

    if (isLocalPlaybackSong(song)) {
        return lyrics ? 'online' : 'none';
    }

    if (isNavidromePlaybackSong(song)) {
        const navidromeSong = song as NavidromeSongLike;
        if (navidromeSong.lyricsSource) {
            return navidromeSong.lyricsSource;
        }
        if (navidromeSong.matchedLyrics) {
            return 'online';
        }
        const hasStructuredLyrics = Array.isArray(navidromeSong.cachedStructuredLyrics)
            ? navidromeSong.cachedStructuredLyrics.length > 0
            : Boolean(navidromeSong.cachedStructuredLyrics?.line.length || navidromeSong.cachedStructuredLyrics?.cueLine?.length);
        if (lyrics || hasStructuredLyrics || navidromeSong.cachedPlainLyrics?.trim()) {
            return 'navi';
        }
        return 'none';
    }

    if (song && lyrics) {
        return 'online';
    }

    return 'none';
};

type NavidromeSongLike = SongResult & {
    lyricsSource?: 'navi' | 'online';
    matchedLyrics?: LyricData;
    cachedStructuredLyrics?: StructuredLyric | StructuredLyric[] | StructuredLyric['line'];
    cachedPlainLyrics?: string;
};

export const hasEnhancedStructuredLines = (item: StructuredLyric): boolean => {
    return item.cueLine?.some(cueLine => cueLine.cue?.some(cue => typeof cue.start === 'number'))
        || item.line?.some(line => detectTimedLyricFormat(line.value) === 'enhanced-lrc')
        || false;
};

export const toDebugLineSnapshot = (line: LyricData['lines'][number] | null) => {
    if (!line) {
        return null;
    }

    const renderHints = getLineRenderHints(line);
    return {
        text: line.fullText || null,
        translation: line.translation ?? null,
        wordCount: line.words.length,
        startTime: line.startTime,
        endTime: line.endTime,
        renderEndTime: renderHints?.renderEndTime ?? null,
        rawDuration: renderHints?.rawDuration ?? Math.max(line.endTime - line.startTime, 0),
        timingClass: renderHints?.timingClass ?? null,
        lineTransitionMode: renderHints?.lineTransitionMode ?? null,
        wordRevealMode: renderHints?.wordRevealMode ?? null,
    };
};
