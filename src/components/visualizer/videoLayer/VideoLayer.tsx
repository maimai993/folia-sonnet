import React, { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PlayerState } from '../../../types';
import { currentTime } from '../../../stores/motionSignals';
import { selectDisplayPlayerState, selectDisplaySong, usePlaybackStore } from '../../../stores/usePlaybackStore';
import { ensureVideoLayerFileRestored, stripInjectPrefix, useVideoLayerSettingsStore } from '../../../stores/useVideoLayerSettingsStore';
import VideoLayerSpinner from './VideoLayerSpinner';

// src/components/visualizer/videoLayer/VideoLayer.tsx
// Built-in muted video behind the lyrics (above the background, under the lyrics). The video follows
// playback without any per-frame React work: play/pause follows the player state, a jump in the
// playback clock (seek, song change) re-aligns it, and slow drift is corrected every few seconds.
// The video position is the song position modulo the video length, so a short loop keeps cycling.
//
// 画面等声音、声音也等画面（下面 `holdForBuffering`）：两边各走各的时候，卡住的那一边没人
// 管，表现就是「声音卡了画面还在飘」或者「画面卡了声音已经跑远，等它回来说话已经晚了」。

const DRIFT_CHECK_MS = 2000;
// A clock step bigger than this between two ticks is a seek or a song change, not playback.
const CLOCK_JUMP_SEC = 1;
// 画面落后这个量就不再「追」，直接对齐：差太多时逐帧追只会拖出一条尾巴。
const CATCH_UP_SEC = 1.5;

interface VideoLayerProps {
    /** The shell's pause signal (window hidden etc.); the video stops even while music plays. */
    paused: boolean;
}

const VideoLayer: React.FC<VideoLayerProps> = ({ paused }) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const alignRef = useRef<() => void>(() => {});
    const { enabled, url, opacity, fit, localFileUrl, injectedUrl } = useVideoLayerSettingsStore(useShallow(state => ({
        enabled: state.videoLayerEnabled,
        url: state.videoLayerUrl,
        opacity: state.videoLayerOpacity,
        fit: state.videoLayerFit,
        localFileUrl: state.localFileUrl,
        injectedUrl: state.injectedUrl,
    })));
    // 注入的那条排最前：它是「现在这一刻该看的东西」，用户自己选的那条只是它的备份。
    //
    // 注入进来的地址带一个固定前缀（见 useVideoLayerSettingsStore 的 INJECT_URL_PREFIX）：那份前缀
    // 是给旁边那些「这条是我放的吗」的判断用的，不是地址本身。这里剥掉再交给 <video>。
    const source = stripInjectPrefix(injectedUrl) ?? localFileUrl ?? (url || null);
    const active = enabled && Boolean(source);
    /*
     * 画面怎么摆，分两种来源说。
     *
     * 注入进来的是平台自己的 MV 投稿：竖屏的裁成中间一条两边全黑，等于把画面大部分
     * 扔了；横屏的又有上下一点点出界。这一层的要求是「看得全」—— 完整显示（contain，
     * 竖屏两侧留黑），一旦连 contain 都摆不下（横屏在窄屏上），宁可拉伸也要让四条边
     * 都在屏幕里。
     *
     * 用户自己上传 / 自己填地址的那份不动：人家选了 cover 还是 contain 是自己的审美，
     * 这层替他做主就是把他的背景改了。
     */
    const isInjected = Boolean(stripInjectPrefix(injectedUrl));
    const isInjectedRef = useRef(isInjected);
    isInjectedRef.current = isInjected;
    const objectFit = isInjected ? 'contain' : fit;
    /*
     * 亮度同理：这层的不透明度是「用户给自己的背景调的透明感」（别的层要从它下面透出来）。
     * 平台注入的 MV 是「现在该看的东西」—— 透过它看见的应该是画面本身，不该被用户
     * 半年前调的那个 0.6 罩上一层灰（用户看到的「视频灰蒙蒙」正是这个）。注入时给满，
     * 换回用户自己的源再还给他调的值。
     */
    const resolvedOpacity = isInjected ? 1 : opacity;

    useEffect(() => {
        ensureVideoLayerFileRestored();
    }, []);

    useEffect(() => {
        const video = videoRef.current;
        if (!active || !video) return;

        /*
         * 卡没卡住：`waiting`/`stalled` 进来、`playing`/`canplay` 出去。
         *
         * 这几个事件是 <video> 自己的话：它在说「我这儿没数据了」「我能放了」。画面出不来
         * 的时候没人告诉用户，看着就是一块裂开的黑块 —— 所以同时把转圈挂上。
         *
         * videoBufferingRef 是给 align 用的：缓冲中的画面**不要**被时钟拽 —— 那正是
         * 「视频一直在那里循环卡」的来源 —— 数据回来（canplay）时一次对齐就够了。
         */
        const videoBufferingRef = { current: false };
        const setBuffering = (value: boolean) => {
            videoBufferingRef.current = value;
            video.dataset.buffering = value ? 'true' : 'false';
        };

        const align = () => {
            // Held still while music plays (the shell's pause): the clock runs on, so following it would
            // only seek a stopped video over and over. It is aligned when the pause lifts.
            if (pausedRef.current && selectDisplayPlayerState(usePlaybackStore.getState()) === PlayerState.PLAYING) return;
            // 缓冲中不做对齐：这一帧还没有数据，seek 到 target 只会让它再空一次 —— 每 2 秒
            // 跳一次、每次都空，画面看起来就是「卡在同一处循环」。等数据回来（canplay）
            // 那一次 align 才跳，跳完就有帧了。
            if (videoBufferingRef.current) return;
            if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
            if (!Number.isFinite(video.duration) || video.duration <= 0 || video.seeking) return;
            const target = currentTime.get() % video.duration;
            const drift = video.currentTime - target;
            /*
             * 差得多就跳，差得少就放着。
             *
             * 超过 CATCH_UP_SEC 说明这段时间画面根本没有数据（缓冲、卡顿、换源），慢慢追
             * 的话用户要看三秒的「刚才」；直接对齐到「现在」。小于 DRIFT_TOLERANCE 的偏差
             * 是正常抖动，硬拉反而会让画面一帧一顿。
             */
            if (Math.abs(drift) > CATCH_UP_SEC) video.currentTime = target;
        };
        /*
         * 播还是停。
         *
         * 这里**只跟随声音**：声音在播，画面就该动；声音停了，画面也停。画面自己卡住
         * （readyState 不够）时不在这里处理 —— 那是「画面追不上声音」，由 align 在数据
         * 到了之后一次对齐，不在卡住期间反复 seek 把缓冲越搞越烂。
         */
        const followState = () => {
            const playing = selectDisplayPlayerState(usePlaybackStore.getState()) === PlayerState.PLAYING;
            if (playing && !pausedRef.current) void video.play().catch(() => {});
            else video.pause();
        };
        const onMetadata = () => {
            setBuffering(false);
            resumeSource();
            align();
            followState();
        };
        alignRef.current = align;

        const onWaiting = () => setBuffering(true);
        const onCanPlay = () => {
            setBuffering(false);
            resumeSource();
            align();
            followState();
        };
        const onPlaying = () => setBuffering(false);
        const onStalled = () => setBuffering(true);
        const onSeeking = () => setBuffering(true);
        const onSeeked = () => setBuffering(false);
        /*
         * 加载失败要说出来。
         *
         * 没有这条监听，源坏了（本地文件被删、句柄失效、url 403、编解码不支持）的表现是
         * 一块永远转圈的空白 —— 用户只能报「视频层加载不出来」，日志里一个字都没有。
         * 这里记下 error.code（MEDIA_ERR_SRC_NOT_SUPPORTED 之类）并标一个 data 属性，
         * 转圈的那一层读到就停，界面不会一直假装在等。
         */
        const onError = () => {
            const error = video.error;
            console.warn('[VideoLayer] the video failed to load', {
                source,
                injected: isInjectedRef.current,
                code: error?.code ?? null,
                message: error?.message ?? '',
            });
            video.dataset.error = 'true';
            setBuffering(false);
        };
        const onLoadedData = () => {
            delete video.dataset.error;
        };
        /*
         * ★ 换源之后**立刻**站到播放器当下的位置，不要从头开始。
         *
         * 换画质 = 换一条 <video> 的 src。新流的时间轴和原来那条是同一支 MV，
         * 所以「该看哪一秒」完全由播放器的 clock 决定：currentTime.get()。
         * 元素复用之后（不再有 key）换源不会把播放进度清零，但**新的这一条流**
         * 本身是从 0 开始的 —— 所以元数据一到就 seek 一次。
         *
         * 只做一次：之后交给 align 的漂移校正。这里和 align 用同一个取模
         * （clock % duration），短片循环的规则因此也和原来一致。
         */
        let resumed = false;
        const resumeSource = () => {
            if (resumed) return;
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            resumed = true;
            const target = currentTime.get() % video.duration;
            // 差得很少就不动它：一次没必要的 seek 会黑一帧。
            if (target > 0.25 && Math.abs(video.currentTime - target) > 0.25) {
                video.currentTime = target;
            }
        };

        video.addEventListener('loadedmetadata', onMetadata);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('canplay', onCanPlay);
        video.addEventListener('playing', onPlaying);
        video.addEventListener('stalled', onStalled);
        video.addEventListener('seeking', onSeeking);
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onError);
        video.addEventListener('loadeddata', onLoadedData);
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onMetadata();
        // 换源那一刻就是缓冲的开始：元数据还没到，画面还什么都没有。
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) setBuffering(true);

        const unsubscribeStore = usePlaybackStore.subscribe((state, previous) => {
            if (selectDisplayPlayerState(state) !== selectDisplayPlayerState(previous)) followState();
            if (selectDisplaySong(state) !== selectDisplaySong(previous)) align();
        });
        let lastClock = currentTime.get();
        let lastClockAt = Date.now();
        /*
         * 音频侧缓冲也要等：时钟不动（音频流没数据了）时视频不追。
         *
         * 音频卡住的表面是「播放器还说是 PLAYING，但 currentTime 不走了」。此时若照常
         * 每 2 秒对齐一次，视频被一次次拽向一个不动的位置 —— 用户看到的就是「画面循环
         * 卡在同一处」。等音频回来、时钟重新走动，下一轮对齐自然接上。
         *
         * 实现只看一条线：时钟最近 4 秒内有没有真的前进过。seek / 切歌（单步跳超过
         * CLOCK_JUMP_SEC）无条件对齐 —— 那是用户主动换位置，跟缓冲无关。
         */
        const unsubscribeClock = currentTime.on('change', (value) => {
            const jump = Math.abs(value - lastClock);
            if (jump > 0.05) lastClockAt = Date.now();
            lastClock = value;
            if (jump > CLOCK_JUMP_SEC) align();
        });
        const drift = window.setInterval(() => {
            // 时钟停着（音频在缓冲、或暂停）就不做漂移对齐 —— 拽了也是拽向一个不动的位置。
            if (Date.now() - lastClockAt < 4000) align();
        }, DRIFT_CHECK_MS);

        return () => {
            window.clearInterval(drift);
            unsubscribeClock();
            unsubscribeStore();
            video.removeEventListener('loadedmetadata', onMetadata);
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('canplay', onCanPlay);
            video.removeEventListener('playing', onPlaying);
            video.removeEventListener('stalled', onStalled);
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            video.removeEventListener('loadeddata', onLoadedData);
            /*
             * 换源时**别在这里 pause**。
             *
             * 元素是复用的（见下面 <video> 上的注释）：这个 cleanup 在每次 source
             * 变化时都会跑一遍，旧代码在这里无条件 pause()，紧接着新 effect 又
             * play() —— 中间那一下停顿就是用户说的「衔接不顺」。真正要停下的时候
             * （这一层关掉了）由 active 那条分支处理。
             */
            if (!active) video.pause();
        };
    }, [active, source]);

    // The shell's pause flag changes without touching the source; only play/pause needs to follow.
    useEffect(() => {
        const video = videoRef.current;
        if (!active || !video) return;
        if (paused) {
            video.pause();
        } else if (selectDisplayPlayerState(usePlaybackStore.getState()) === PlayerState.PLAYING) {
            alignRef.current();
            void video.play().catch(() => {});
        }
    }, [active, paused]);

    /*
     * 没有源就什么都不画。
     *
     * 这一层在 MV 背景下面是**唯一的画面来源**（MV 背景自己什么都不画，画面全靠这里
     * 注入）。所以「开着、但一条源都没有」不能渲染任何铺满全屏的东西 —— 尤其是不能
     * 让它带着自己的底色/黑底，那样用户看到的就是「切到 MV 整块黑」；从 MV 切走时
     * 这里也要立刻让位，把下面真正选中的那款背景露出来。
     */
    if (!active || !source) return null;

    return (
        <>
            {/*
               * ★ 不给 key。
               *
               * 这里原来写着 key={source}：换画质、换源时 React 会把整个 <video> 拆掉重建，
               * 于是（1）进度归零 —— 用户报的「换清晰度之后时间轴被重置」；（2）旧元素先拆、
               * 新元素后挂，中间那一帧是黑的 —— 观感上就是闪一下。
               *
               * 现在元素自始至终是同一个，只换 src。换源之后 position 由 align 拉到
               * 「播放器现在的位置」（见下面 resumeSource 那段），所以画面从正确的
               * 地方开始，而不是从 0 开始。
               */}
            <video
                ref={videoRef}
                src={source}
                muted
                loop
                playsInline
                /*
                 * 别写 auto。
                 *
                 * `preload="auto"` 的意思是「尽量把整条都拉下来」，而这条流是一整支 MV
                 * —— 一首几十分钟的投稿就是几百兆，连着听一晚上几 GB 起步（用户实测
                 * 跑掉 20 GB）。这里只需要开头一点点来出画面，后面的由播放器按需去要。
                 */
                preload="metadata"
                aria-hidden
                className="absolute inset-0 h-full w-full pointer-events-none"
                style={{ opacity: resolvedOpacity, objectFit, width: '100%', height: '100%' }}
            />
            <VideoLayerSpinner videoRef={videoRef} />
        </>
    );
};

export default VideoLayer;
