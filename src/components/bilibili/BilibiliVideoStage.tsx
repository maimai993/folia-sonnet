import React from 'react';
import { selectDisplaySong, usePlaybackStore } from '../../stores/usePlaybackStore';
import { isBilibiliAvailable } from '../../services/bilibili/transport';
import {
    dropStreamsExcept,
    ensureStream,
    forgetStreamQuality,
    peekStream,
    prefetchQueueStreams,
    streamTargetOf,
} from '../../services/bilibili/streamPrefetch';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import {
    isInjectedVideoUrl,
    useVideoLayerSettingsStore,
    withInjectPrefix,
} from '../../stores/useVideoLayerSettingsStore';
import { acquireVideoLayerEnabled } from '../../services/videoLayerEnabledLease';

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
    const target = React.useMemo(() => streamTargetOf(displaySong), [displaySong]);

    /*
     * 画面按哪一档取。
     *
     * 面板上那一行「画质」写的正是这份（见 buildPlayerPanelModel 的 onAudioQualityChange），
     * MV 背景自己的子选项写的也是它 —— 两处写同一个值，这里只读这一个，
     * 换画质就一定会重新取流（以前缓存只按 bvid 记，换档之后命中的还是老地址，
     * 画面纹丝不动，「换画质不重新加载」就是这个）。
     */
    const quality = useBilibiliMvStore(state => state.quality);
    /*
     * 画面要跟声音走同一个上限。
     *
     * 以前这里还留着一句「用户从没动过就用 standard」，那是音频默认值改成 1080P
     * （useAudioSettingsStore 的 DEFAULT_AUDIO_QUALITY）之前的老规矩 —— 现在默认就是
     * ultra，再把它按回 standard 等于用户设了 1080P、画面却只取 480P。
     * 直接信 store 里那一档；组件没拿到（quality 为空）时也回 store 的，不自己猜。
     */
    const audioQuality = useAudioSettingsStore(state => state.audioQuality);
    const effectiveQuality = React.useMemo(
        () => quality || audioQuality,
        [quality, audioQuality],
    );

    // 队列一变就把里面所有投稿的地址取回来。
    // 切歌时画面才不至于等一次网络往返才出来。
    const playQueue = usePlaybackStore(state => state.playQueue);
    React.useEffect(() => {
        if (playQueue.length === 0) return;
        prefetchQueueStreams(playQueue, effectiveQuality);
        // 队列里已经没有的那些，缓存留着没意义。
        dropStreamsExcept(playQueue);
    }, [playQueue, effectiveQuality]);

    const [videoUrl, setVideoUrl] = React.useState('');

    // 取画面。声音不在这里换：播放器已经通过 provider 的 getAudioSource 放的是
    // 这条投稿的 DASH 音轨，两端同一个 cid，天生同步。
    //
    // 先看预取缓存：队列一变 streamPrefetch 就把整条队列的地址取回来了，
    // 切歌时这里直接命中，不用等两个往返（详情 + 取流）才出画面。
    React.useEffect(() => {
        if (!target || !isBilibiliAvailable()) {
            setVideoUrl('');
            return undefined;
        }
        const ready = peekStream(target.bvid, effectiveQuality, target.cid);
        if (ready) {
            setVideoUrl(ready);
            return undefined;
        }
        let alive = true;
        setVideoUrl('');
        void (async () => {
            const entry = await ensureStream(target.bvid, effectiveQuality, target.cid, target.epId);
            if (!alive) return;
            // 取不到画面只是没有背景，声音照放：不要因此影响播放。
            setVideoUrl(entry?.videoUrl ?? '');
        })();
        return () => { alive = false; };
    }, [target, effectiveQuality]);

    // 换画质时把这一首其它档的缓存清掉，免得下次又命中一条不对档的地址。
    const previousQuality = React.useRef(effectiveQuality);
    React.useEffect(() => {
        if (previousQuality.current === effectiveQuality) return;
        previousQuality.current = effectiveQuality;
        if (target) forgetStreamQuality(target.bvid, target.cid);
    }, [effectiveQuality, target]);

    /*
     * 注入到视频层。
     *
     * 三条规矩：
     * 1. 带的地址有固定前缀，旁边才分得清「这条是注入的」和「用户自己选的」；
     * 2. 切换时先清空、下一帧再写新的 —— 直接换的话 `<video>` 上还挂着上一条的
     *    src，两个源抢同一个元素，画面会裂开或放不出来；
     * 3. 清理时只清带前缀的那条，用户自己的视频层永远不碰。
     *
     * 「这一层要不要露出来」另外借一份，和 BilibiliMvLayer 同一个计数
     * （见 services/videoLayerEnabledLease）：画面的开关归租约管，不归注入管。
     */
    React.useEffect(() => {
        const store = useVideoLayerSettingsStore.getState();
        // 先把上一条注入的摘掉（用户自己的不动）。
        if (isInjectedVideoUrl(store.injectedUrl)) store.setInjectedUrl(null);
        /*
         * 没有地址时**只做清理、不早退**。
         *
         * 这里早先写的是 `if (!videoUrl) return undefined;` —— 于是「地址还在 ->
         * 地址变空」这一次依赖变化，React 先跑上一轮的清理（把注入槽位清成 null），
         * 再跑这一轮的 body，body 一进来就 return，**没有任何人把槽位写回去**。
         * 视频层于是落在「有 MV 背景、但没有源」的状态：整个画面是黑的，切到
         * 别的背景也回不来（槽位一直是 null，组件以为已经卸干净了）。
         */
        if (!videoUrl) {
            return () => {
                const current = useVideoLayerSettingsStore.getState();
                if (isInjectedVideoUrl(current.injectedUrl)) current.setInjectedUrl(null);
            };
        }

        const release = acquireVideoLayerEnabled();
        const frame = requestAnimationFrame(() => {
            const current = useVideoLayerSettingsStore.getState();
            const next = withInjectPrefix(videoUrl);
            if (current.injectedUrl !== next) current.setInjectedUrl(next);
        });
        return () => {
            cancelAnimationFrame(frame);
            const current = useVideoLayerSettingsStore.getState();
            if (isInjectedVideoUrl(current.injectedUrl)) current.setInjectedUrl(null);
            release();
        };
    }, [videoUrl]);

    return null;
};

export default BilibiliVideoStage;
