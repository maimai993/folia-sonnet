import React from 'react';
import {
    selectDisplayDuration,
    selectDisplaySong,
    usePlaybackStore,
} from '../../stores/usePlaybackStore';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { useVideoLayerSettingsStore } from '../../stores/useVideoLayerSettingsStore';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import { isBilibiliAvailable } from '../../services/bilibili/transport';

// src/components/bilibili/BilibiliMvLayer.tsx
// 把「这首歌的 MV」接到播放页上。它自己不画任何东西。
//
// 画面交给现成的视频层（visualizer/videoLayer）—— 那一层本来就是静音的、跟着播放走的
// 一块视频背景。这里只做一件事：把 B 站的画面流**临时注入**到那一层的运行时槽位里
// （useVideoLayerSettingsStore.injectedUrl，不落盘，重启就没了）。
//
// 声音交给播放器：把 audioSrc 换成 B 站 DASH 的那条声音轨。两端来自同一个投稿，
// 所以进度条、歌词、可视化全部照旧，不需要任何音画偏移。
//
// 预取也放在这里而不是 store 内部：要知道「下一首是哪一首」只有播放队列知道，
// store 不该反过来依赖队列。

/** 一首歌的 MV 缓存键。标题和歌手都规整过，免得大小写 / 空格差异算成两首。 */
export const songKeyOf = (
    title: string | null | undefined,
    artist: string | null | undefined,
): string => `${(title ?? '').trim().toLowerCase()}|||${(artist ?? '').trim().toLowerCase()}`;

/** 从一首歌里取 MV 需要的两个字段。 */
const describe = (song: unknown): { title: string; artist: string } => {
    if (!song || typeof song !== 'object') return { title: '', artist: '' };
    const s = song as { name?: string | null };
    return {
        title: s.name ?? '',
        artist: getSongArtistLabel(song as never) || '',
    };
};

const BilibiliMvLayer: React.FC = () => {
    const enabled = useBilibiliMvStore(state => state.enabled);
    const displaySong = usePlaybackStore(selectDisplaySong);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const duration = usePlaybackStore(selectDisplayDuration);

    const current = React.useMemo(() => describe(displaySong), [displaySong]);
    const songKey = React.useMemo(
        () => songKeyOf(current.title, current.artist),
        [current.title, current.artist],
    );

    // 队列里当前这首的下一条就是「下一首」。
    const nextSong = React.useMemo(() => {
        if (!displaySong) return null;
        const currentId = (displaySong as { id?: string }).id;
        if (!currentId) return playQueue[0] ?? null;
        const index = playQueue.findIndex(song => (song as { id?: string }).id === currentId);
        return index >= 0 ? (playQueue[index + 1] ?? null) : (playQueue[0] ?? null);
    }, [displaySong, playQueue]);
    const next = React.useMemo(() => describe(nextSong), [nextSong]);

    const active = enabled && isBilibiliAvailable() && current.title.length > 0;

    // 当前这首：没解析过就解析（store 有缓存，同一首不会重复搜）。
    React.useEffect(() => {
        if (!active) return;
        void useBilibiliMvStore.getState().resolveForSong(
            songKey,
            current.title,
            current.artist,
            Number.isFinite(duration) ? duration : 0,
        );
    }, [active, songKey, current.title, current.artist, duration]);

    // 下一首提前解析：只在开关打开时做，store 里再判一次。
    React.useEffect(() => {
        if (!active || !next.title) return;
        useBilibiliMvStore.getState().prefetchNext(
            songKeyOf(next.title, next.artist),
            next.title,
            next.artist,
            Number.isFinite(duration) ? duration : 0,
        );
    }, [active, next.title, next.artist, duration]);

    const videoUrl = useBilibiliMvStore(state => (
        active ? state.bySongKey[songKey]?.stream?.videoUrl ?? '' : ''
    ));
    const audioUrl = useBilibiliMvStore(state => (
        active ? state.bySongKey[songKey]?.stream?.audioUrl ?? '' : ''
    ));

    /*
     * 画面：注入到视频层。离开时清掉注入，用户原本选的视频（如果有）原样回来。
     *
     * 不落盘：injectedUrl 只在内存里，所以重启之后一定回到用户自己的选择。
     */
    React.useEffect(() => {
        if (!videoUrl) return undefined;
        useVideoLayerSettingsStore.getState().setInjectedUrl(videoUrl);
        return () => {
            const store = useVideoLayerSettingsStore.getState();
            // 只有「现在注入的还是这一条」才清：换歌时新的那条已经写进去了。
            if (store.injectedUrl === videoUrl) store.setInjectedUrl(null);
        };
    }, [videoUrl]);

    /*
     * 声音：把播放器的音源换成 B 站那条 DASH 声音轨。
     *
     * 换掉之后播放器放的就是 MV 原声，而进度条、歌词、可视化、拖动都还在读播放器
     * 自己的时钟 —— 一行都不用改。离开时还原成换之前那条，仍然只动运行时的那一个值，
     * 不进任何持久化设置。
     */
    const setAudioSrc = usePlaybackStore(state => state.setAudioSrc);
    React.useEffect(() => {
        if (!audioUrl) return undefined;
        const previous = usePlaybackStore.getState().audioSrc;
        if (previous === audioUrl) return undefined;
        setAudioSrc(audioUrl);
        return () => {
            if (usePlaybackStore.getState().audioSrc === audioUrl) {
                setAudioSrc(previous ?? '');
            }
        };
    }, [audioUrl, setAudioSrc]);

    return null;
};

export default BilibiliMvLayer;
