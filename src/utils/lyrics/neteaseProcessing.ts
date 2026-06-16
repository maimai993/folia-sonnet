import { LyricData } from '../../types';
import { applyDetectedChorusEffects, applyNeteaseChorusByTime } from './chorusEffects';
import type { NeteaseChorusRange } from './chorusEffects';
import { detectTimedLyricFormat } from './formatDetection';
import { resolveLyricProcessingOptions } from './filtering';
import { hasNeteasePureMusicFlag, isPureMusicLyricText } from './pureMusic';
import type { LyricProcessingOptions, RawNeteaseLyric } from './types';
import { parseLyricsAsync } from './workerClient';
import { neteaseApi } from '../../services/netease';

export interface ExtractedNeteaseLyricPayload {
    mainLrc: string | null;
    yrcLrc: string | null;
    transLrc: string | null;
    isPureMusic: boolean;
}

export interface ProcessedNeteaseLyricsResult extends ExtractedNeteaseLyricPayload {
    lyrics: LyricData | null;
    chorusRanges?: NeteaseChorusRange[];
}

export const extractNeteaseLyricPayload = (source?: RawNeteaseLyric | null): ExtractedNeteaseLyricPayload => {
    const mainLrc = source?.lrc?.lyric || null;
    const yrcLrc = source?.yrc?.lyric || source?.lrc?.yrc?.lyric || null;
    const ytlrc = source?.ytlrc?.lyric || source?.lrc?.ytlrc?.lyric || null;
    const tlyric = source?.tlyric?.lyric || null;
    const transLrc = (yrcLrc && ytlrc) ? ytlrc : tlyric;
    const isPureMusic = hasNeteasePureMusicFlag(source) || isPureMusicLyricText(mainLrc);

    return {
        mainLrc,
        yrcLrc,
        transLrc,
        isPureMusic
    };
};

export const processNeteaseLyrics = async (
    source?: RawNeteaseLyric | null,
    options: LyricProcessingOptions = {}
): Promise<ProcessedNeteaseLyricsResult> => {
    const payload = extractNeteaseLyricPayload(source);
    const primaryLyrics = payload.yrcLrc || payload.mainLrc;

    if (!primaryLyrics || payload.isPureMusic) {
        return {
            ...payload,
            lyrics: null,
            chorusRanges: []
        };
    }

    const format = payload.yrcLrc ? 'yrc' : detectTimedLyricFormat(payload.mainLrc || primaryLyrics);
    const chorusPromise = options.songId && payload.mainLrc
        ? neteaseApi.getChorus(options.songId).catch((error) => {
            console.warn(`[processNeteaseLyrics] Failed to fetch API-based chorus for song ${options.songId}, falling back to text-based detection:`, error);
            return null;
        })
        : null;
    let lyrics = await parseLyricsAsync(
        format,
        primaryLyrics,
        payload.transLrc || '',
        resolveLyricProcessingOptions(options)
    );

    if (lyrics) {
        lyrics.isWordByWord = !!payload.yrcLrc;
    }

    let chorusRanges: NeteaseChorusRange[] = [];

    if (lyrics && payload.mainLrc) {
        let chorusApplied = false;
        if (chorusPromise) {
            const chorusRes = await chorusPromise;
            if (chorusRes && chorusRes.code === 200) {
                const ranges = chorusRes.chorus || chorusRes.data || [];
                if (Array.isArray(ranges) && ranges.length > 0) {
                    const parsedRanges = ranges.map((r: any) => ({
                        startTime: (r.startTime ?? 0) / 1000,
                        endTime: (r.endTime ?? 0) / 1000
                    }));
                    chorusRanges = parsedRanges;
                    lyrics = applyNeteaseChorusByTime(lyrics, parsedRanges);
                    chorusApplied = true;
                    console.log(`[processNeteaseLyrics] Applied API-based chorus detection for song ${options.songId}. Ranges: ${JSON.stringify(parsedRanges)}`);
                }
            }
        }

        if (!chorusApplied) {
            lyrics = applyDetectedChorusEffects(lyrics, payload.mainLrc);
            console.log(`[processNeteaseLyrics] Applied text-based chorus detection fallback for song ${options.songId ?? 'unknown'}`);
        }
    }

    return {
        ...payload,
        lyrics,
        chorusRanges
    };
};
