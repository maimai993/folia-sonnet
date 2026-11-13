import React from 'react';
import {
    selectDisplayDuration,
    selectDisplaySong,
    usePlaybackStore,
} from '../../stores/usePlaybackStore';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { isInjectedVideoUrl, useVideoLayerSettingsStore, withInjectPrefix } from '../../stores/useVideoLayerSettingsStore';
import { bilibiliBvidOf } from '../../services/bilibili/bilibiliNormalize';
import { fetchBilibiliPlayUrl, fetchBilibiliVideoInfo } from '../../services/bilibili/api';
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

    /*
     * 正在放的这首歌**本身就是一条 B 站视频**（用户从 B 站推荐页或搜索里点的它）。
     *
     * 这条路不走匹配：它就是视频，画面和声音都是它自己的。匹配那条路只用于
     * 「放的是别的平台的歌、想给它找个 MV」。
     */
    const ownBvid = React.useMemo(
        () => bilibiliBvidOf(displaySong as { id?: string } | null),
        [displaySong],
    );
    const isOwnVideo = ownBvid.length > 0;

    const active = enabled && isBilibiliAvailable() && current.title.length > 0 && !isOwnVideo;

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

    // 匹配出来的那条（给别的平台的歌找的 MV）。自己就是视频时不看这里。
    const matchedVideoUrl = useBilibiliMvStore(state => (
        active ? state.bySongKey[songKey]?.stream?.videoUrl ?? '' : ''
    ));
    const matchedAudioUrl = useBilibiliMvStore(state => (
        active ? state.bySongKey[songKey]?.stream?.audioUrl ?? '' : ''
    ));

    /*
     * 自己就是视频时，画面和声音都现取。
     *
     * 播放器那一侧已经通过 provider 的 getAudioSource 把**声音**换成了这条视频的
     * DASH 音轨，这里只需要再取一次画面地址注入视频层 —— 两端来自同一个 cid，
     * 所以天然同步。
     */
    const [ownVideoUrl, setOwnVideoUrl] = React.useState('');
    React.useEffect(() => {
        if (!isOwnVideo) {
            setOwnVideoUrl('');
            return undefined;
        }
        let alive = true;
        void (async () => {
            try {
                const info = await fetchBilibiliVideoInfo(ownBvid);
                const track = await fetchBilibiliPlayUrl(ownBvid, info.cid);
                if (alive) setOwnVideoUrl(track.url);
            } catch (error) {
                // 取不到画面就只是没有背景，声音照放，不要影响播放。
                console.warn('[Bilibili] Video stream unavailable', error);
                if (alive) setOwnVideoUrl('');
            }
        })();
        return () => { alive = false; };
    }, [isOwnVideo, ownBvid]);

    const videoUrl = isOwnVideo ? ownVideoUrl : matchedVideoUrl;
    // 自己就是视频时声音由播放器那边换（getAudioSource），这里不重复换。
    const audioUrl = isOwnVideo ? '' : matchedAudioUrl;

    /*
     * 画面：注入到视频层。离开时清掉注入，用户原本选的视频（如果有）原样回来。
     *
     * 不落盘：injectedUrl 只在内存里，所以重启之后一定回到用户自己的选择。
     *
     * 切换时**先清空、下一帧再写新的**。直接换的话，`<video>` 上还挂着上一条的
     * src，两个源抢同一个元素，表现就是画面裂开 / 放不出来。先清空让元素回到
     * 「没有源」的状态，再把新的写进去，它才会重新走一次加载。
     */
    React.useEffect(() => {
        if (!videoUrl) return undefined;
        const store = useVideoLayerSettingsStore.getState();
        // 上一条（如果还是注入的那条）先摘掉 —— 用户自己的视频不动。
        if (store.injectedUrl && isInjectedVideoUrl(store.injectedUrl)) store.setInjectedUrl(null);
        // 一帧之后再写：让 <video> 先把上一条彻底卸掉。写的这一条带上前缀，
        // 之后才分得清「这条是注入的」和「用户自己选的」。
        const frame = requestAnimationFrame(() => {
            useVideoLayerSettingsStore.getState().setInjectedUrl(withInjectPrefix(videoUrl));
        });
        return () => {
            cancelAnimationFrame(frame);
            const current = useVideoLayerSettingsStore.getState();
            // 只清自己写进去的那条；用户自己选的视频层永远不碰。
            if (current.injectedUrl && isInjectedVideoUrl(current.injectedUrl)) current.setInjectedUrl(null);
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
