import React from 'react';
import {
    selectDisplayDuration,
    selectDisplaySong,
    usePlaybackStore,
} from '../../stores/usePlaybackStore';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { isInjectedVideoUrl, useVideoLayerSettingsStore, withInjectPrefix } from '../../stores/useVideoLayerSettingsStore';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import { isBilibiliAvailable } from '../../services/bilibili/transport';
import { registerMvRequirementSink } from '../../services/mvRequirement';
import { acquireVideoLayerEnabled } from '../../services/videoLayerEnabledLease';
import { useLyricSettingsStore } from '../../stores/useLyricSettingsStore';
import { isBilibiliSongId } from '../../services/bilibili/bilibiliProvider';

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
    /*
     * 开关只有一个：外观设置里壁纸背景选了「MV」。
     *
     * 以前这里还有一个「连接与集成」的独立开关 —— 同一件事摆两处，用户开了这处
     * 不知道那处，入口收编成一个：背景模式 === 'mv'。歌词样式的「MV」款仍能强制
     * 打开（forcedByStyle，见 services/mvRequirement），那是"这款背景就要画面"的
     * 表达，不属于用户开关。
     */
    const backgroundMode = useVisualizerSettingsStore(state => state.lyricsWallpaperBackground);
    /*
     * 背景模式选了「MV」（歌词动画设置 → 背景）也是总开关，而且是**持久**的那一个。
     *
     * 只靠 forcedByStyle 有个坑：requirement 是当前挂载的背景组件写的，而「无歌词」
     * 这类样式不画背景（background: false）—— 换到那类样式时 MV 背景组件整个卸载，
     * requirement 放开，画面就消失，切回来也不一定恢复（注入槽位被清过）。
     * 读持久化的模式选择就没有这个问题：开关跟着设置走，跟当前画的是哪款歌词样式无关。
     */
    const visualizerBackgroundMode = useVisualizerSettingsStore(state => state.visualizerBackgroundMode);
    /*
     * ★ 先无条件把 hook 调出来，再参与布尔运算。
     *
     * 原来第三个 hook 直接写在 `||` 短路链里。背景一切到 MV，前两项命中短路，
     * 这个 hook 就不被调用了 —— hook 数量从 N 变 N-1，React 抛
     * "Rendered fewer hooks than expected"，整棵 React 树被卸载，#root 变空，
     * 露出 WebView 的 #09090b 底色：用户看到的就是「整个应用黑屏，只能杀进程」。
     * 切出去时方向相反（hooks 变多），一样崩。这跟视频源、流中转都无关，
     * 之前修 early-return / LRU 自然都不见效。
     */
    const forcedByStyle = useBilibiliMvStore(state => state.forcedByStyle);
    const enabled = backgroundMode === 'mv'
        || visualizerBackgroundMode === 'mv'
        || forcedByStyle;
    /*
     * 背景样式要求画面时从这里进来（见 services/mvRequirement）。
     *
     * 挂载时登记一次：样式那边只写一个布尔值，不知道是谁在听。
     */
    React.useEffect(() => registerMvRequirementSink(
        required => useBilibiliMvStore.getState().setForcedByStyle(required),
    ), []);
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
     * 「歌本身就是视频」那一条不在这里，见 BilibiliVideoStage。
     *
     * 这里只管「放的是别的平台的歌，给它找一条 MV」。两者分成两个组件，是因为
     * 合在一起时两条路抢同一个注入槽位，切歌会互相清掉对方的东西。
     */
    /*
     * 自己就是投稿的那首歌，这里一律不参与。
     *
     * 这一层管的是「放的是别的平台的歌，给它找一条 MV」。而一条 B 站投稿的画面和
     * 声音都由 BilibiliVideoStage 负责 —— 两边同时上手，就是两条音轨一起响
     * （用户听到的「放了两个声音」），画面也会互相抢同一个注入槽位。
     *
     * 所以按 id 判掉，不靠注释约定。
     *
     * 例外（B 站当背景来源）：B 站的歌也允许给它配画面 —— 但**只注入画面、不注入
     * 声音**（声音是这条投稿自己的，播放器已经在放了，再换就是两个声音）。画面走
     * 这一层，声音走 BilibiliVideoStage，两半各管各的。
     */
    const isOwnPost = isBilibiliSongId((displaySong as { id?: string } | null)?.id);
    /*
     * ★ B 站自己的投稿，这一层**整个不参与**（不是只掐掉声音）。
     *
     * 以前 active 没管 isOwnPost：声音确实没注入（下面那个 effect 判了），但**画面照注入**，
     * 于是它会盖到 BilibiliVideoStage 注入的同一条投稿上 —— 用户看到的是「放视频的时候
     * 又匹配了一层 MV 把画面盖住了」。画面和声音都由 BilibiliVideoStage 负责，
     * 这一层对这类歌没有存在的理由。
     *
     * 效果：B 站曲目开着「MV」背景时，看到的仍然是那条投稿自己的画面，不再被
     * 「匹配来的 MV」覆盖。
     */
    const active = enabled && isBilibiliAvailable() && current.title.length > 0 && !isOwnPost;

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
     *
     * 切换时**先清空、下一帧再写新的**。直接换的话，`<video>` 上还挂着上一条的
     * src，两个源抢同一个元素，表现就是画面裂开 / 放不出来。先清空让元素回到
     * 「没有源」的状态，再把新的写进去，它才会重新走一次加载。
     *
     * 「要不要把这一层露出来」另外借一份（见 services/videoLayerEnabledLease），
     * 而且只在真的有画面时借：以前是在 setInjectedUrl 里硬开并落盘，背景预览里看一眼
     * 「MV」就把这一层永久打开了（issue #432）。租约记下开关的原值，这一条撤掉、或者
     * 切到别的背景以后才回滚，且只回滚它自己开的那一次。
     */
    React.useEffect(() => {
        const store = useVideoLayerSettingsStore.getState();
        // 上一条（如果还是注入的那条）先摘掉 —— 用户自己的视频不动。
        if (store.injectedUrl && isInjectedVideoUrl(store.injectedUrl)) store.setInjectedUrl(null);
        /*
         * 没有地址时**只做清理，不早退**。
         *
         * 这里早先写的是 `if (!videoUrl) return undefined;` —— 于是「地址还在 ->
         * 地址变空」这一次依赖变化，React 先跑上一轮的清理（把槽位清成 null），
         * 再跑这一轮的 body，而 body 一进来就 return，**没有任何人把槽位写回去**。
         * 视频层于是落在「有 MV 背景、但没有源」的状态：整个画面是黑的，切到
         * 别的背景也回不来（槽位一直是 null，组件以为已经卸干净了）。
         *
         * 现在两种情形都走同一条路：先把旧的那条摘掉，有新的就一帧后写进去，
         * 没有就让它保持空 —— 清理只做一次，不会漏。
         */
        if (!videoUrl) {
            return () => {
                const current = useVideoLayerSettingsStore.getState();
                if (current.injectedUrl && isInjectedVideoUrl(current.injectedUrl)) current.setInjectedUrl(null);
            };
        }
        const release = acquireVideoLayerEnabled();
        // 一帧之后再写：让 <video> 先把上一条彻底卸掉。写的这一条带上前缀，
        // 之后才分得清「这条是注入的」和「用户自己选的」。
        const frame = requestAnimationFrame(() => {
            const current = useVideoLayerSettingsStore.getState();
            const next = withInjectPrefix(videoUrl);
            // 值没变就别 setState：高频回调里无条件写会连带把整条订阅链重渲染一遍。
            if (current.injectedUrl !== next) current.setInjectedUrl(next);
        });
        return () => {
            cancelAnimationFrame(frame);
            const current = useVideoLayerSettingsStore.getState();
            // 只清自己写进去的那条；用户自己选的视频层永远不碰。
            if (current.injectedUrl && isInjectedVideoUrl(current.injectedUrl)) current.setInjectedUrl(null);
            release();
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
    /*
     * 字幕用哪一边的（见 useLyricSettingsStore 的 mvLyricSource）。
     *
     * 默认 `platform`：这首歌自己平台的歌词不动，MV 只当画面。选 `bilibili` 时才把
     * 这条投稿的字幕换上来 —— 字幕和画面同源，卡点更准，但那份字幕经常只是占位。
     *
     * 换歌词和换音源是同一件事的两半：都只在「这条 MV 真的在放」时才做，离开时还原。
     */
    const mvLyricSource = useLyricSettingsStore(state => state.mvLyricSource);
    const subtitles = useBilibiliMvStore(state => (
        active && mvLyricSource === 'video' ? state.bySongKey[songKey]?.stream?.subtitles ?? null : null
    ));
    const setLyrics = usePlaybackStore(state => state.setLyricsState);

    /*
     * 选 `bilibili` 时把这条投稿的字幕换上，离开时还原成原来那份。
     *
     * 只换「显示什么」，不动播放位置：字幕自己的时间轴和这首歌是同一条投稿，
     * 两边对得上。拿不到字幕（null）就什么都不做 —— 保持原平台歌词，而不是把
     * 屏幕清空。
     */
    React.useEffect(() => {
        if (!subtitles) return undefined;
        const previous = usePlaybackStore.getState().lyrics;
        if (previous === subtitles) return undefined;
        setLyrics(subtitles);
        return () => {
            if (usePlaybackStore.getState().lyrics === subtitles) setLyrics(previous);
        };
    }, [subtitles, setLyrics]);

    React.useEffect(() => {
        // B 站自己的歌声音已经在放这条投稿了（BilibiliVideoStage 管），再换音源就是
        // 两个声音 —— 音源注入对它们跳过，只注入画面（见上面 active 的注释）。
        if (isOwnPost || !audioUrl) return undefined;
        const previous = usePlaybackStore.getState().audioSrc;
        if (previous === audioUrl) return undefined;
        setAudioSrc(audioUrl);
        return () => {
            if (usePlaybackStore.getState().audioSrc === audioUrl) {
                setAudioSrc(previous ?? '');
            }
        };
    }, [audioUrl, setAudioSrc, isOwnPost]);

    return null;
};

export default BilibiliMvLayer;
