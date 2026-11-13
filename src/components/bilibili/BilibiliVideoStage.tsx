import React from 'react';
import { selectDisplaySong, usePlaybackStore } from '../../stores/usePlaybackStore';
import { isBilibiliAvailable } from '../../services/bilibili/transport';
import { fetchBilibiliPlayUrl, fetchBilibiliVideoInfo } from '../../services/bilibili/api';
import { bilibiliBvidOf } from '../../services/bilibili/bilibiliNormalize';
import {
    isInjectedVideoUrl,
    useVideoLayerSettingsStore,
    withInjectPrefix,
} from '../../stores/useVideoLayerSettingsStore';

// src/components/bilibili/BilibiliVideoStage.tsx
// 正在放的这首歌**本身就是一条投稿**时，把它的画面铺到播放页。
//
// 和 BilibiliMvLayer 是两件事，所以分成两个组件：
// - 这个文件管「歌就是视频」—— 用户从推荐页或搜索里点的就是这条投稿，
//   画面和声音都来自它自己，不涉及任何匹配；
// - BilibiliMvLayer 管「放的是别的平台的歌，给它找一条 MV」。
//
// 合在一起写过一版，两条路抢同一个注入槽位，切歌时会互相清掉对方的东西。
// 分开之后各自只碰自己那一条。

const BilibiliVideoStage: React.FC = () => {
    const displaySong = usePlaybackStore(selectDisplaySong);
    const bvid = React.useMemo(
        () => bilibiliBvidOf(displaySong as { id?: string } | null),
        [displaySong],
    );

    const [videoUrl, setVideoUrl] = React.useState('');

    // 取画面。声音不在这里换：播放器已经通过 provider 的 getAudioSource 放的是
    // 这条投稿的 DASH 音轨，两端同一个 cid，天生同步。
    React.useEffect(() => {
        if (!bvid || !isBilibiliAvailable()) {
            setVideoUrl('');
            return undefined;
        }
        let alive = true;
        setVideoUrl('');
        void (async () => {
            try {
                const info = await fetchBilibiliVideoInfo(bvid);
                const track = await fetchBilibiliPlayUrl(bvid, info.cid);
                if (alive) setVideoUrl(track.url);
            } catch (error) {
                // 取不到画面只是没有背景，声音照放：不要因此影响播放。
                console.warn('[Bilibili] Video stream unavailable', error);
                if (alive) setVideoUrl('');
            }
        })();
        return () => { alive = false; };
    }, [bvid]);

    /*
     * 注入到视频层。
     *
     * 三条规矩：
     * 1. 带的地址有固定前缀，旁边才分得清「这条是注入的」和「用户自己选的」；
     * 2. 切换时先清空、下一帧再写新的 —— 直接换的话 `<video>` 上还挂着上一条的
     *    src，两个源抢同一个元素，画面会裂开或放不出来；
     * 3. 清理时只清带前缀的那条，用户自己的视频层永远不碰。
     */
    React.useEffect(() => {
        const store = useVideoLayerSettingsStore.getState();
        // 先把上一条注入的摘掉（用户自己的不动）。
        if (isInjectedVideoUrl(store.injectedUrl)) store.setInjectedUrl(null);
        if (!videoUrl) return undefined;

        const frame = requestAnimationFrame(() => {
            useVideoLayerSettingsStore.getState().setInjectedUrl(withInjectPrefix(videoUrl));
        });
        return () => {
            cancelAnimationFrame(frame);
            const current = useVideoLayerSettingsStore.getState();
            if (isInjectedVideoUrl(current.injectedUrl)) current.setInjectedUrl(null);
        };
    }, [videoUrl]);

    return null;
};

export default BilibiliVideoStage;
