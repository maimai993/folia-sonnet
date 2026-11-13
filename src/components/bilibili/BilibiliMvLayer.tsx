import React from 'react';
import { usePlaybackStore, selectDisplaySong, selectDisplayDuration, selectDisplayPlayerState } from '../../stores/usePlaybackStore';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { lyricCurrentTime } from '../../stores/motionSignals';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import { isBilibiliAvailable } from '../../services/bilibili/transport';
import { PlayerState } from '../../types';
import { songKeyOf } from './BilibiliMvStage';

const BilibiliMvStage = React.lazy(() => import('./BilibiliMvStage'));

// src/components/bilibili/BilibiliMvLayer.tsx
// 播放页上的 MV 背景层（挂在 AppSurface 的视觉层里、SceneHost 之上）。
//
// 三件事：开关打开且放着歌才挂；这首歌解析好之后铺上画面；顺手把下一首也解析好。
//
// 预取放在这里而不是 store 内部：要知道「下一首是哪一首」只有播放队列知道，
// store 不该反过来依赖队列。同一时刻只预取一首由 store 自己保证。

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
    const playerState = usePlaybackStore(selectDisplayPlayerState);
    const duration = usePlaybackStore(selectDisplayDuration);

    const current = React.useMemo(() => describe(displaySong), [displaySong]);

    // 队列里当前这首的下一条就是「下一首」。
    const nextSong = React.useMemo(() => {
        if (!displaySong) return null;
        const currentId = (displaySong as { id?: string }).id;
        if (!currentId) return playQueue[0] ?? null;
        const index = playQueue.findIndex(song => (song as { id?: string }).id === currentId);
        return index >= 0 ? (playQueue[index + 1] ?? null) : (playQueue[0] ?? null);
    }, [displaySong, playQueue]);
    const next = React.useMemo(() => describe(nextSong), [nextSong]);

    // 下一首提前解析：只在开关打开时做，store 里再判一次。
    React.useEffect(() => {
        if (!enabled || !next.title) return;
        useBilibiliMvStore.getState().prefetchNext(
            songKeyOf(next.title, next.artist),
            next.title,
            next.artist,
            Number.isFinite(duration) ? duration : 0,
        );
    }, [enabled, next.title, next.artist, duration]);

    /*
     * 声音：把播放器的音源换成 bilibili 那条 DASH 音频流。
     *
     * 这是整个 MV 方案的关键一步。换成它之后，播放器放的是 MV 的原声，
     * 而进度条、歌词、可视化、拖动 —— 全都还在读播放器自己的时钟，一个字不用改。
     * 画面那条流只是静音的视频，跟着同一个时钟走（见 BilibiliMvBackground）。
     * 两端同源，所以不存在音画偏移。
     *
     * 什么时候换回去：关掉 MV、换歌、解析失败、拿不到独立音轨（老投稿）。
     * 靠 effect 的 cleanUp 做还原，保证任何一条路径离开都会还回歌曲本身。
     */
    const songKey = React.useMemo(
        () => songKeyOf(current.title, current.artist),
        [current.title, current.artist],
    );
    const mvAudioUrl = useBilibiliMvStore(state => {
        if (!enabled) return '';
        return state.bySongKey[songKey]?.stream?.audioUrl ?? '';
    });
    const setAudioSrc = usePlaybackStore(state => state.setAudioSrc);

    React.useEffect(() => {
        if (!mvAudioUrl) return undefined;
        const previous = usePlaybackStore.getState().audioSrc;
        if (previous === mvAudioUrl) return undefined;
        setAudioSrc(mvAudioUrl);
        return () => {
            // 只有「现在放的还是 MV 那条」才还原：中途换歌时播放器已经自己换了新的。
            if (usePlaybackStore.getState().audioSrc === mvAudioUrl) {
                setAudioSrc(previous ?? '');
            }
        };
    }, [mvAudioUrl, setAudioSrc]);

    // 没有原生桥、没开开关、没歌：都不挂。
    if (!enabled || !isBilibiliAvailable() || !current.title) return null;

    return (
        <React.Suspense fallback={null}>
            <BilibiliMvStage
                songTitle={current.title}
                songArtist={current.artist}
                currentTime={lyricCurrentTime}
                duration={Number.isFinite(duration) ? duration : 0}
                paused={playerState !== PlayerState.PLAYING}
            />
        </React.Suspense>
    );
};

export default BilibiliMvLayer;
