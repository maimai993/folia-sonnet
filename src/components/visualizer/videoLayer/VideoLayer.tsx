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
    const objectFit = isInjected ? 'contain' : fit;

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
         */
        const setBuffering = (value: boolean) => {
            video.dataset.buffering = value ? 'true' : 'false';
        };

        const align = () => {
            // Held still while music plays (the shell's pause): the clock runs on, so following it would
            // only seek a stopped video over and over. It is aligned when the pause lifts.
            if (pausedRef.current && selectDisplayPlayerState(usePlaybackStore.getState()) === PlayerState.PLAYING) return;
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
            align();
            followState();
        };
        alignRef.current = align;

        const onWaiting = () => setBuffering(true);
        const onCanPlay = () => {
            setBuffering(false);
            align();
            followState();
        };
        const onPlaying = () => setBuffering(false);
        const onStalled = () => setBuffering(true);
        const onSeeking = () => setBuffering(true);
        const onSeeked = () => setBuffering(false);

        video.addEventListener('loadedmetadata', onMetadata);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('canplay', onCanPlay);
        video.addEventListener('playing', onPlaying);
        video.addEventListener('stalled', onStalled);
        video.addEventListener('seeking', onSeeking);
        video.addEventListener('seeked', onSeeked);
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onMetadata();
        // 换源那一刻就是缓冲的开始：元数据还没到，画面还什么都没有。
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) setBuffering(true);

        const unsubscribeStore = usePlaybackStore.subscribe((state, previous) => {
            if (selectDisplayPlayerState(state) !== selectDisplayPlayerState(previous)) followState();
            if (selectDisplaySong(state) !== selectDisplaySong(previous)) align();
        });
        let lastClock = currentTime.get();
        const unsubscribeClock = currentTime.on('change', (value) => {
            if (Math.abs(value - lastClock) > CLOCK_JUMP_SEC) align();
            lastClock = value;
        });
        const drift = window.setInterval(align, DRIFT_CHECK_MS);

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
            video.pause();
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

    if (!active || !source) return null;

    return (
        <>
            <video
                ref={videoRef}
                key={source}
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
                style={{ opacity, objectFit, width: '100%', height: '100%' }}
            />
            <VideoLayerSpinner videoRef={videoRef} />
        </>
    );
};

export default VideoLayer;
