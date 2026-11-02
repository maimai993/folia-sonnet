import { useCallback, useEffect, useRef } from 'react';
import { useMotionValueEvent } from 'framer-motion';
import { PlayerState, type SongResult } from '../types';
import { currentTime } from '../stores/motionSignals';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { isListeningArchiveEnabled } from '../stores/useListeningArchiveSettingsStore';
import { saveArchivePlay } from '../services/listeningArchive/repository';
import {
    countsAsCompleted,
    countsAsPlay,
    normalizeSongKey,
    splitSegments,
} from '../services/listeningArchive/rules';
import type { ArchivePlay } from '../services/listeningArchive/types';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { getProviderSongMetadata, getSongCoverUrl } from '../services/onlineMusic/songMetadata';

// src/hooks/useListeningArchiveRecorder.ts
// 听歌档案的采集：把「这一次真的响了多少秒」攒成一条 ArchivePlay。
//
// 口径照 utils/playbackListenTracker 和 useRecentPlaysRecorder：只有**正向且不超过 2 秒**的一步
// 才算真的在放，拖动、回退、暂停、卡顿后的一次性追赶都不计。进度读的是 `currentTime` 这个
// MotionValue（见 stores/motionSignals），用 useMotionValueEvent 订阅 —— 绝不把它写进 React
// state，否则整棵树会按帧重渲染（见 skills/frontend-runtime-guardrails）。
//
// 结算时机：换歌、暂停超过 PAUSE_SETTLE_MS、页面被隐藏。跨午夜不在这里拆：一行里的
// `segments` 交给数据层的 splitSegments，口径由那一处唯一决定。

/** 一步跨得比这还大，就是拖动、跳转或卡顿后的追赶，不是连续播放。 */
const MAX_STEP_SECONDS = 2;

/** 暂停超过这么久，这一次播放就结束了；再响起来算新的一次。 */
const PAUSE_SETTLE_MS = 3 * 60 * 1000;

/**
 * 不足这么多秒的片段不留：按 30 秒的口径本来就计不上（见 rules.countsAsPlay），
 * 但「点了下一首」的那半秒也不该在库里堆成行。
 */
const MIN_SETTLED_SECONDS = 5;

type RecorderSession = {
    /** 播放身份（来源 + 媒体 id）：换歌的判据，也是记录 id 的一部分。 */
    playbackKey: string;
    /** 归一后的歌曲键（rules.normalizeSongKey）：排行与单曲轨迹的分组依据。 */
    songKey: string;
    /** 开始播放的本地时刻（毫秒）。 */
    startedAt: number;
    /** 上一次读到播放位置；null 表示还没有锚点（第一帧不计）。 */
    lastPosition: number | null;
    listenedSeconds: number;
};

/** 连歌名都取不到时的占位：至少让排行里那一条能认出来是哪一首。 */
const songKeyFallback = (artists: string[]): string => (artists[0] ? artists[0] : 'unknown');

/** 这一刻这首歌的档案行除时长以外的字段。 */
const describeSong = (song: SongResult) => {
    const metadata = getProviderSongMetadata(song);
    const sourceRef = getPlaybackSourceRef(song);
    const title = (song.name || '').trim();
    const artists = metadata.artists.map(artist => artist.name).filter(name => name !== '');
    return {
        songId: sourceRef.mediaId,
        providerId: sourceRef.kind === 'online' ? sourceRef.providerId : sourceRef.kind,
        title: title || songKeyFallback(artists),
        artists,
        albumName: metadata.album?.name?.trim() || null,
        coverUrl: getSongCoverUrl(song) ?? null,
        totalSeconds: metadata.durationMs > 0 ? metadata.durationMs / 1000 : 0,
        songKey: normalizeSongKey({ title: title || songKeyFallback(artists), artists }),
    };
};

/**
 * 把攒好的一段变成落库的 ArchivePlay。
 *
 * `totalSeconds` / 秒数取「现在」的值：曲目时长常常在开始播放之后才拿到，元数据也会在播放中补齐。
 * 时间到这一刻为止，秒数只认累加器里那几个正向步进。
 */
const buildArchivePlay = (session: RecorderSession, song: SongResult, endedAt: number): ArchivePlay => {
    const described = describeSong(song);
    const audioSeconds = usePlaybackStore.getState().duration;
    const totalSeconds = Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : described.totalSeconds;
    const listenedSeconds = Math.max(0, session.listenedSeconds);
    return {
        id: `${session.playbackKey}|${session.startedAt}`,
        songKey: described.songKey,
        songId: described.songId,
        providerId: described.providerId,
        title: described.title,
        artists: described.artists,
        albumName: described.albumName,
        coverUrl: described.coverUrl,
        startedAt: session.startedAt,
        endedAt: Math.max(endedAt, session.startedAt),
        listenedSeconds,
        totalSeconds,
        counted: countsAsPlay(listenedSeconds, totalSeconds),
        completed: countsAsCompleted(listenedSeconds, totalSeconds),
        segments: splitSegments(session.startedAt, Math.max(endedAt, session.startedAt), listenedSeconds),
    };
};

/**
 * 订阅当前曲目、播放状态与播放位置，把整段播放结算成一条档案记录。
 *
 * 全部记账都放在 ref 里：这个 hook 挂在 App 播放桥那一层，会在播放过程中反复重渲染，
 * 进度回调又按帧触发 —— 任何一处走进 state 都会把整条高频路径变成 React 更新。
 */
export const useListeningArchiveRecorder = (): void => {
    const sessionRef = useRef<RecorderSession | null>(null);
    const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 元数据会在播放途中补齐，结算时取的是**那一刻**的这首歌。
    const songRef = useRef<SongResult | null>(null);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const playerState = usePlaybackStore(state => state.playerState);
    songRef.current = currentSong;

    const clearPauseTimer = useCallback(() => {
        if (pauseTimerRef.current) {
            clearTimeout(pauseTimerRef.current);
            pauseTimerRef.current = null;
        }
    }, []);

    /** 关掉当前这一段并按口径落库；不足 MIN_SETTLED_SECONDS 或采集关着都直接丢掉。 */
    const settle = useCallback((endedAt: number) => {
        clearPauseTimer();
        const session = sessionRef.current;
        sessionRef.current = null;
        const song = songRef.current;
        if (!session || !song) return;
        if (!isListeningArchiveEnabled()) return;
        if (session.listenedSeconds < MIN_SETTLED_SECONDS) return;
        const play = buildArchivePlay(session, song, endedAt);
        void saveArchivePlay(play).catch((error: unknown) => {
            console.warn('[ListeningArchive] 保存播放记录失败', error);
        });
    }, [clearPauseTimer]);

    /** 为这首歌开一段新的记账；上一段由调用方先结算。 */
    const open = useCallback((song: SongResult, startedAt: number) => {
        const described = describeSong(song);
        sessionRef.current = {
            playbackKey: getPlaybackSongKey(song),
            songKey: described.songKey,
            startedAt,
            lastPosition: null,
            listenedSeconds: 0,
        };
    }, []);

    /**
     * 一帧一次：只认正向且不超过 MAX_STEP_SECONDS 的一步。
     *
     * 步进的锚点每帧都更新（不论这一步算不算数），所以一次拖动之后的第一帧不会把整段跳过的
     * 距离记成「听过」。
     */
    const handlePosition = useCallback((position: number) => {
        const session = sessionRef.current;
        if (!session || !Number.isFinite(position)) return;
        if (!isListeningArchiveEnabled()) {
            // 关掉采集时不开新账，也不攒：再打开时从那一刻重新算。
            sessionRef.current = null;
            return;
        }
        const previous = session.lastPosition;
        session.lastPosition = position;
        if (previous === null || !Number.isFinite(previous)) return;
        // 只有状态机说「在放」才认：暂停、拉起中、被系统抢走音频焦点都不是真的在响。
        if (usePlaybackStore.getState().playerState !== PlayerState.PLAYING) return;
        const step = position - previous;
        if (step <= 0 || step > MAX_STEP_SECONDS) return;
        session.listenedSeconds += step;
    }, []);

    useMotionValueEvent(currentTime, 'change', handlePosition);

    // 换歌：上一段结算，下一段从这一刻开始算。
    const playbackKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    useEffect(() => {
        const session = sessionRef.current;
        if (session && session.playbackKey !== playbackKey) {
            settle(Date.now());
        }
        if (currentSong && !sessionRef.current) {
            open(currentSong, Date.now());
        }
    }, [currentSong, open, playbackKey, settle]);

    // 暂停：停够 PAUSE_SETTLE_MS 就结算；回到播放时如果那一段已经结算了，重新开一段。
    useEffect(() => {
        clearPauseTimer();
        if (playerState === PlayerState.PLAYING) {
            if (currentSong && !sessionRef.current) {
                open(currentSong, Date.now());
            }
            return clearPauseTimer;
        }
        if (!sessionRef.current) return clearPauseTimer;
        pauseTimerRef.current = setTimeout(() => settle(Date.now()), PAUSE_SETTLE_MS);
        return clearPauseTimer;
    }, [clearPauseTimer, currentSong, open, playerState, settle]);

    // 页面被隐藏（切后台、锁屏、关窗口前）：当场结算，别等到下一次切歌。
    // 回到前台时如果还在放同一首，刚才那一段已经结算过了 —— 重新开一段，否则后半首整段漏记：
    // 曲目与播放状态都没变，前面那两个 effect 不会重跑。
    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === 'hidden') {
                settle(Date.now());
                return;
            }
            const song = songRef.current;
            if (!song || sessionRef.current) return;
            if (usePlaybackStore.getState().playerState !== PlayerState.PLAYING) return;
            open(song, Date.now());
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibility);
            clearPauseTimer();
        };
    }, [clearPauseTimer, open, settle]);
};

export default useListeningArchiveRecorder;
