import type { LyricData, SongResult } from '../../types';
import type { PlaybackRepresentation } from '../../types/playbackRecovery';
import { decodeAtRate, readLocalTrackBytes } from '../analysis/trackAudio';
import { buildVocalBandEnvelope, estimateAutoAlign, type AutoAlignResult } from '../../utils/lyrics/autoAlignOffset';
import { hasProviderKeptSongAudio } from '../onlineMusic/providerRegistry';

// src/services/lyrics/autoLyricCalibration.ts
//
// 「自动校准」的取数与解码：把一首歌读到 8 kHz 单声道，算出人声频段的能量包络，交给
// autoAlignOffset 估整曲偏移。
//
// 为什么是 8 kHz：人声的能量几乎全在 250–3400 Hz，8 kHz 采样（奈奎斯特 4 kHz）刚好够，
// 四分钟的歌在内存里只有 7.7 MB 浮点；decodeAudioData 会按 context 的采样率直接重采样，
// 不需要额外的 render pass。
//
// 为什么不在这里下载在线歌曲：为了一次校准去下一整首歌，用户不一定愿意，而且播放器自己
// 的缓存策略更清楚哪些歌在本地。这里只读「已经在这台机器上」的字节（media cache / 本地文件），
// 读不到就是读不到，面板上会说明原因。

/** 分析用的采样率。 */
const ANALYSIS_RATE = 8000;
/** 能量包络的帧率：10 ms 一帧，寻峰的精度就够，再密只是白算。 */
const ENVELOPE_FPS = 100;
/** 超过这个长度就不分析了：长播客/现场版分析收益低，代价却是整段解码。 */
const MAX_DURATION_SEC = 12 * 60;

export type AutoCalibrationStatus = 'ok' | 'no-audio' | 'too-long' | 'no-lyrics' | 'decode-failed';

export interface AutoCalibrationOutcome extends AutoAlignResult {
    status: AutoCalibrationStatus;
}

const skip = (status: AutoCalibrationStatus, reason: AutoAlignResult['reason']): AutoCalibrationOutcome => ({
    status, offsetMs: 0, confidence: 0, samples: 0, applied: false, reason,
});

/**
 * 估这一首的整曲偏移。不写任何状态：调用方决定要不要应用。
 *
 * `audioUrl` / `representation` 由调用方传，因为只有播放链路知道当前这首歌实际是从哪里读的。
 */
export const calibrateLyricsForSong = async (
    song: SongResult,
    lyrics: LyricData | null,
    audioUrl: string | null,
    representation: PlaybackRepresentation | null = null,
): Promise<AutoCalibrationOutcome> => {
    if (!lyrics?.lines?.length) {
        return skip('no-lyrics', 'not-enough-lines');
    }

    /*
     * 三条来源都可能给出这一首的字节：播放表示（转码）、媒体缓存、本地文件；
     * 外加一条「平台自己在本地留了一份」—— 那些歌播完后不会写进我们的缓存目录，
     * 但播放地址本身就是那份本地文件，能读就该读，否则它们永远是「没有本地音频」。
     */
    const read = await readLocalTrackBytes(song, {
        representation,
        audioUrl,
        mayReadOnlineUrl: url => hasProviderKeptSongAudio(song, url),
    });
    if (!read || !('bytes' in read)) {
        console.info(`[AutoCalibrate] ${String(song.id)}: no local audio to read${read && 'skipped' in read ? ` (${read.skipped})` : ''}`);
        return skip('no-audio', 'not-enough-lines');
    }

    const buffer = await decodeAtRate(read.bytes, ANALYSIS_RATE);
    if (!buffer) {
        return skip('decode-failed', 'not-enough-lines');
    }
    if (buffer.duration > MAX_DURATION_SEC) {
        return skip('too-long', 'not-enough-lines');
    }

    const samples = buffer.getChannelData(0);
    const envelope = buildVocalBandEnvelope(samples, ANALYSIS_RATE, ENVELOPE_FPS);
    // decodeAtRate 是单声道 context：拿到的是 (L+R)/2，人声本来就居中最响。
    const result = estimateAutoAlign(envelope, ENVELOPE_FPS, lyrics.lines);
    console.info(
        `[AutoCalibrate] ${String(song.id)}: ${result.applied ? `${result.offsetMs} ms` : `no change (${result.reason})`}`
        + ` | ${result.samples} lines, confidence ${(result.confidence * 100).toFixed(0)}% | ${buffer.duration.toFixed(1)}s`,
    );
    return { ...result, status: 'ok' };
};
