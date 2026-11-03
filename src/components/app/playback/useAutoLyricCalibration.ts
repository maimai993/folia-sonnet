import { useEffect, useRef } from 'react';
import { PlayerState } from '../../../types';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { readLyricOffset, writeLyricOffset } from '../../../utils/lyrics/lyricOffsetMemory';
import { readCalibrationRecord, writeCalibrationRecord } from '../../../utils/lyrics/lyricCalibrationMemory';
import { useLyricCalibrationStore } from '../../../stores/useLyricCalibrationStore';
import { calibrateLyricsForSong } from '../../../services/lyrics/autoLyricCalibration';
import { onAudioCached } from '../../../services/audioCache';
import { hasCachedSongAudio } from '../../../services/onlineMusic/resourceCache';
import { getSongResourceCacheKey } from '../../../services/onlineMusic/resourceKeys';

// src/components/app/playback/useAutoLyricCalibration.ts
//
// 一首歌播起来之后，在后台自己算一次「这首的歌词整体偏了多少」，算出来就写进本曲偏移。
//
// 几个刻意的克制：
//  · 等 4 秒再动手。切歌那几秒本身就在解码、取封面、铺歌词，这时候再解一遍整首歌的音频，
//    用户听到的就是开头的卡顿。
//  · 只在这一首**还没有任何偏移**时跑。用户手动调过就是最终答案，自动结果不许覆盖它
//    （面板上按「重新校准」是例外：那一下就是用户让它覆盖）。
//  · 「分析过」才记一次（按歌曲 + 行数 + 首行时间做键）。**读不到音频不算分析过** ——
//    在线歌曲的缓存是播完才写的，第一次播放时读不到很正常；记成失败就等于把这首歌永久
//    排除在自动校准之外，「听完缓存就能用」也就无从谈起。
//  · 拿不到音频的那一首，等它真的写进缓存（onAudioCached）再补一次。
//  · 拿到结果后再确认一次「还是这首歌、偏移还是 0」，防止这几秒里用户自己调过了。

/** 播放稳定多久之后开始算。 */
const DELAY_MS = 4000;
/** 用户自己按了「重新校准」时，几乎立刻跑。 */
const MANUAL_DELAY_MS = 120;
const ATTEMPTS_KEY = 'lyric_auto_calibration_attempts';
const MAX_ATTEMPTS = 300;

const attemptKey = (songId: string | number, lineCount: number, firstStart: number): string =>
    `${String(songId)}::${lineCount}::${firstStart.toFixed(2)}`;

const readAttempts = (): Record<string, number> => {
    if (typeof window === 'undefined') {
        return {};
    }
    try {
        const raw = localStorage.getItem(ATTEMPTS_KEY);
        const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        const result: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'number') {
                result[key] = value;
            }
        }
        return result;
    } catch {
        return {};
    }
};

const markAttempt = (key: string): void => {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        const attempts = readAttempts();
        attempts[key] = Date.now();
        const keys = Object.keys(attempts);
        if (keys.length > MAX_ATTEMPTS) {
            keys.sort((left, right) => attempts[left] - attempts[right])
                .slice(0, keys.length - MAX_ATTEMPTS)
                .forEach(stale => delete attempts[stale]);
        }
        localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
    } catch {
        // 记不住就这次会话内靠内存挡一下，不影响校准。
    }
};

export function useAutoLyricCalibration(): void {
    const songId = usePlaybackStore(state => state.currentSong?.id);
    const playerState = usePlaybackStore(state => state.playerState);
    const lineCount = usePlaybackStore(state => state.lyrics?.lines.length ?? 0);
    const firstStart = usePlaybackStore(state => state.lyrics?.lines[0]?.startTime ?? -1);
    const autoEnabled = useLyricCalibrationStore(state => state.autoEnabled);
    const phase = useLyricCalibrationStore(state => state.phase);
    const runToken = useLyricCalibrationStore(state => state.runToken);
    const setResult = useLyricCalibrationStore(state => state.setResult);
    const resetResult = useLyricCalibrationStore(state => state.reset);

    /** 上一次已经消化过的令牌：令牌变了就说明这一轮是用户按的「重新校准」。 */
    const seenTokenRef = useRef(runToken);
    /** 这一轮 effect 是不是用户按的。effect 里读令牌，回调里要用同一个判断。 */
    const manualRef = useRef(false);
    /**
     * 「发现缓存了，再扫一次」已经用掉的次数。有缓存却仍然扫不出结果（比如缓存是试听
     * 片段被判掉、或者解码不支持）时，不能每问一次就重跑一次 —— 那会变成一个死循环。
     */
    const recheckRunsRef = useRef<Map<string, number>>(new Map());

    /*
     * 换歌：先清掉上一首的结论，再把这个歌上次的结论贴回来。
     *
     * 判过「不用调」的歌也记了结论，下次播放不会再扫（尝试表里有它），面板要是只显示
     * 「播放后自动对齐」，用户会以为自己上次的等待白等了。
     */
    useEffect(() => {
        resetResult();
        if (songId === undefined || songId === null) {
            return;
        }
        const record = readCalibrationRecord(songId);
        const currentOffset = readLyricOffset(songId);

        // 自动对齐过的歌：值还在就照实说；被手动改成了别的数，就说「手动优先」。
        if (record?.phase === 'applied') {
            if (currentOffset === record.offsetMs) {
                setResult('applied', record.offsetMs);
            } else if (currentOffset !== 0) {
                setResult('manual');
            }
            return;
        }
        // 这一首有手动偏移，自动校准本来就不该介入 —— 与其说「没有本地音频」，不如说实话。
        if (currentOffset !== 0) {
            setResult('manual');
            return;
        }
        if (!record) {
            return;
        }
        setResult(record.phase, 0, record.reason);
    }, [resetResult, setResult, songId]);

    useEffect(() => {
        if (!autoEnabled || songId === undefined || songId === null || lineCount === 0) {
            // 手动重跑撞上「这首歌没歌词」时，别让面板一直停在「正在分析」。
            if (useLyricCalibrationStore.getState().phase === 'running') {
                setResult('idle');
            }
            return undefined;
        }

        const manual = runToken !== seenTokenRef.current;
        if (manual) {
            seenTokenRef.current = runToken;
        }
        manualRef.current = manual;

        // 播起来再做：暂停在某一首上时，用户并没有在听，没必要解一首歌的音频。
        // 用户自己按的按钮是例外 —— 他看着这一首点的，就是现在要。
        if (playerState !== PlayerState.PLAYING && !manual) {
            return undefined;
        }
        // 已经有偏移（用户手动调过，或上一次自动算过）就不再动它。
        // 状态要如实说是「手动优先」，不能让它停在上一轮的「没有本地音频」。
        if (!manual && readLyricOffset(songId) !== 0) {
            setResult('manual');
            return undefined;
        }

        const key = attemptKey(songId, lineCount, firstStart);
        if (!manual && readAttempts()[key]) {
            return undefined;
        }

        let cancelled = false;
        const timer = window.setTimeout(() => {
            const state = usePlaybackStore.getState();
            const song = state.currentSong;
            const lyrics = state.lyrics;
            if (!song || String(song.id) !== String(songId) || !lyrics) {
                return;
            }
            setResult('running');
            void calibrateLyricsForSong(song, lyrics, state.audioSrc)
                .then((outcome) => {
                    if (cancelled) {
                        return;
                    }
                    const live = usePlaybackStore.getState();
                    if (String(live.currentSong?.id) !== String(songId)) {
                        return;
                    }
                    // 只有真的拿到音频、真的分析过才记账。没缓存的那一首要留着下次再试，
                    // 否则「先听一遍、缓存好了再播」永远等不到自动对齐。
                    if (outcome.status !== 'no-audio') {
                        markAttempt(key);
                    }
                    if (!outcome.applied) {
                        if (outcome.status === 'ok') {
                            const reason = outcome.reason ?? null;
                            setResult('skipped', 0, reason);
                            // 记下来：下次播放这一首，面板还能说出上次为什么没改。
                            writeCalibrationRecord(songId, { phase: 'skipped', offsetMs: 0, reason });
                        } else if (outcome.status === 'too-long') {
                            // 读到音频了，只是没扫。以前这里和「没有音频」共用一句话，
                            // 用户看到的就是「明明播完了却说没本地音频」。
                            setResult('too-long');
                            writeCalibrationRecord(songId, { phase: 'too-long', offsetMs: 0, reason: null });
                        } else if (outcome.status === 'decode-failed') {
                            setResult('decode-failed');
                            writeCalibrationRecord(songId, { phase: 'decode-failed', offsetMs: 0, reason: null });
                        } else if (outcome.status === 'no-lyrics') {
                            setResult('idle');
                        } else {
                            setResult('no-audio');
                        }
                        return;
                    }
                    // 这几秒里用户可能自己调过了：那以用户为准。手动重跑除外 —— 他就是要覆盖。
                    if (!manualRef.current && live.lyricTimelineOffsetMs !== 0) {
                        setResult('skipped');
                        return;
                    }
                    live.setLyricTimelineOffsetMs(outcome.offsetMs);
                    writeLyricOffset(songId, outcome.offsetMs);
                    writeCalibrationRecord(songId, { phase: 'applied', offsetMs: outcome.offsetMs, reason: null });
                    setResult('applied', outcome.offsetMs);
                })
                .catch((error) => {
                    console.warn('[AutoCalibrate] failed', error);
                    if (!cancelled) {
                        setResult('no-audio');
                    }
                });
        }, manual ? MANUAL_DELAY_MS : DELAY_MS);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [autoEnabled, firstStart, lineCount, playerState, runToken, setResult, songId]);

    /*
     * 「明明播完了，面板还说没有本地音频」的唯一来源：缓存是播完那一刻才写的，而扫描是在
     * 播放 4 秒时做的。若那一刻 WebView 在后台（被冻结），缓存写好的通知到不了前台，
     * 状态就一直停在 no-audio。这里在回到前台时，以及状态每次落到 no-audio 时，回头问一次
     * 缓存：有就补扫，没有就保持「没有音频」—— 不让一个过时的结论一直挂在面板上。
     */
    useEffect(() => {
        if (!autoEnabled || songId === undefined || songId === null) {
            return undefined;
        }
        const key = String(songId);
        const recheck = () => {
            const live = usePlaybackStore.getState();
            const song = live.currentSong;
            if (!song || String(song.id) !== key) {
                return;
            }
            if (useLyricCalibrationStore.getState().phase !== 'no-audio') {
                return;
            }
            if (readLyricOffset(songId) !== 0) {
                return;
            }
            if ((recheckRunsRef.current.get(key) ?? 0) >= 2) {
                return;
            }
            void hasCachedSongAudio(song).then((cached) => {
                if (!cached) {
                    return;
                }
                const now = usePlaybackStore.getState();
                if (!now.currentSong || String(now.currentSong.id) !== key) {
                    return;
                }
                if (useLyricCalibrationStore.getState().phase !== 'no-audio') {
                    return;
                }
                recheckRunsRef.current.set(key, (recheckRunsRef.current.get(key) ?? 0) + 1);
                console.info('[AutoCalibrate] the audio is in the cache now, scanning again');
                useLyricCalibrationStore.getState().requestRun();
            }).catch(() => {
                // 查不到就维持「没有音频」，下次回前台再问。
            });
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') {
                recheck();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('focus', recheck);
        recheck();
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', recheck);
        };
    }, [autoEnabled, phase, songId]);

    /*
     * 缓存刚写好：那一首如果刚才「读不到音频」，现在能读了，补跑一次。
     *
     * 在线歌曲的缓存是「播完再写」的（playedTrackCache），所以第一次播完时校准必然扑空。
     * 没有这一条，用户要等到下一次播放才会顺带对齐；有了它，缓存落盘的那一刻就补上。
     */
    useEffect(() => {
        if (!autoEnabled || songId === undefined || songId === null) {
            return undefined;
        }
        return onAudioCached((cacheKey) => {
            const state = usePlaybackStore.getState();
            const song = state.currentSong;
            if (!song || String(song.id) !== String(songId)) {
                return;
            }
            if (cacheKey !== getSongResourceCacheKey('audio', song)) {
                return;
            }
            if (readLyricOffset(songId) !== 0) {
                return;
            }
            // 只补「没有音频」那一档：算过 / 正在算的都不该被缓存写入打断。
            if (useLyricCalibrationStore.getState().phase !== 'no-audio') {
                return;
            }
            useLyricCalibrationStore.getState().requestRun();
        });
    }, [autoEnabled, songId]);
}
