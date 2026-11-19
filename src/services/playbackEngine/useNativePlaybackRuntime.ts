import { useEffect, useRef, useSyncExternalStore } from 'react';
import { PlayerState } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { setDuration, setPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { isNativePlaybackReconciling, subscribeNativePlaybackSync } from './nativePlaybackSync';
import type { MutableRefObject } from 'react';
import { currentTime } from '../../stores/motionSignals';
import { nativePlaybackEngine } from './nativePlaybackEngine';
import { publishNativeResume, takeNativeResume, usePendingResumeStore } from '../../stores/usePendingResumeStore';

// src/services/playbackEngine/useNativePlaybackRuntime.ts
//
// 把原生播放器接进现有的播放状态机（P1：最小闭环）。
//
// 这一层只补「`<audio>` 元素原来自己干的那几件事」：
//   · 地址来了 → 装进播放器（原来靠 `src` 属性）
//   · 想自动播 → 调 play（原来在 usePlaybackAudioBridge 里由 shouldAutoPlay 驱动）
//   · 时长出来了 → 写 duration（原来 `onLoadedMetadata`）
//   · 播完了 → 交给队列（原来 `onEnded`）
//   · 播不出来 → 报错（原来 `onError`）
//
// 剩下的（音量、seek、暂停、进度条时钟）分别在 syncOutputGain / seekMainAudio /
// transport / usePlaybackVisualizerBridge 里各接一次。
//
// ⚠️ 时钟不在这里写：进度条与歌词由 usePlaybackVisualizerBridge 的 rAF 统一从
// `nativePlaybackEngine.getPositionSec()` 读，避免两个写手抢同一个 motion signal。

type UseNativePlaybackRuntimeOptions = {
    /** 原生播放开着的那一刻才生效；关掉时这一层完全不参与。 */
    enabled: boolean;
    audioSrc: string | null;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    /**
     * 窗口交接、转码恢复等非会话路径的起点（秒）；会话恢复单独核对音源与意图。
     */
    pendingResumeTimeRef: MutableRefObject<number | null>;
    isLyricsLoading: boolean;
    getTargetPlaybackVolume: () => number;
    /** 单曲循环：交给 ExoPlayer 自己重复，Web 侧就收不到 `ended` 了（这正是想要的）。 */
    repeatOne: boolean;
    onEnded: () => void;
    onError: (message: string) => void;
};

export const useNativePlaybackRuntime = ({
    enabled,
    audioSrc,
    shouldAutoPlayRef,
    pendingResumeTimeRef,
    isLyricsLoading,
    getTargetPlaybackVolume,
    repeatOne,
    onEnded,
    onError,
}: UseNativePlaybackRuntimeOptions): void => {
    // 回调每次渲染都换身份，进 effect 依赖会把订阅反复重建。
    const callbacksRef = useRef({ onEnded, onError, getTargetPlaybackVolume, repeatOne });
    callbacksRef.current = { onEnded, onError, getTargetPlaybackVolume, repeatOne };

    const reconciling = useSyncExternalStore(subscribeNativePlaybackSync, isNativePlaybackReconciling, () => false);
    const takes = enabled && !reconciling && nativePlaybackEngine.supports(audioSrc);
    // 会话恢复的续播位置走 store：位置晚到时值会变化，触发下面装源 effect 重跑。
    const resumeRevision = usePendingResumeStore(state => state.revision);

    // 地址 → 播放器。blob 地址（本地歌）原生吃不下，那种歌整首回落到 <audio>。
    useEffect(() => {
        if (!enabled || reconciling || isNativePlaybackReconciling() || !audioSrc) return;
        const live = usePlaybackStore.getState();
        if (audioSrc !== live.audioSrc || !nativePlaybackEngine.supports(audioSrc)) return;
        const songKey = live.currentSong ? getPlaybackSongKey(live.currentSong) : null;
        nativePlaybackEngine.setRepeatMode(callbacksRef.current.repeatOne ? 1 : 0);
        const pending = takeNativeResume();
        const resume = pending?.url === audioSrc && pending.songKey === songKey && pending.stillWanted()
            && (pending.sourceToken === undefined || pending.sourceToken === nativePlaybackEngine.currentSourceToken()) ? pending : null;
        // 非会话的 ref（窗口交接/转码恢复）仍走原有协议；会话位置从不回退到无 key 的副本。
        const refPosition = pendingResumeTimeRef.current;
        pendingResumeTimeRef.current = null;
        const sameSource = nativePlaybackEngine.activeUrl() === audioSrc && nativePlaybackEngine.currentSongKey() === songKey;
        // 位置通知不是用户重试：上一单已经失败时，不能仅因读到了秒数又重装同一首。
        if (resume && sameSource && nativePlaybackEngine.sourceReadyError()) return;
        if (!sameSource || nativePlaybackEngine.sourceReadyError()) {
            const expectedSourceGeneration = nativePlaybackEngine.sourceGeneration() + 1;
            void nativePlaybackEngine.setSource(audioSrc, {
                songKey,
                startPositionMs: refPosition === null || resume ? null : Math.max(0, Math.round(refPosition * 1000)),
            }).catch((error: unknown) => {
                if (nativePlaybackEngine.sourceGeneration() !== expectedSourceGeneration || nativePlaybackEngine.activeUrl() !== audioSrc) return;
                const sourceError = nativePlaybackEngine.sourceReadyError();
                if (sourceError && sourceError !== error) return;
                console.error('[NativePlayer] prepare failed', error);
                callbacksRef.current.onError(String(error));
            });
        }
        if (resume) {
            const ownsSource = () => {
                const state = usePlaybackStore.getState();
                return revision === usePendingResumeStore.getState().revision && resume.stillWanted() && state.audioSrc === resume.url && !!state.currentSong
                    && getPlaybackSongKey(state.currentSong) === resume.songKey;
            };
            const sourceToken = nativePlaybackEngine.currentSourceToken();
            const revision = usePendingResumeStore.getState().revision;
            void nativePlaybackEngine.seekForResume(resume.seconds, ownsSource, () => {
                // 已发布过更新的位置（即便也已被消费），不许旧命令重新排到它后面。
                if (!sourceToken || revision !== usePendingResumeStore.getState().revision) return;
                publishNativeResume({ ...resume, sourceToken });
            }).catch((error: unknown) => {
                console.error('[NativePlayer] resume seek failed', error);
            });
        } else if (sameSource && refPosition !== null) {
            void nativePlaybackEngine.seek(refPosition).catch((error: unknown) => console.error('[NativePlayer] seek failed', error));
        }
    }, [audioSrc, enabled, reconciling, resumeRevision, pendingResumeTimeRef]);

    // 关掉开关、或没有歌了 → 收掉播放器，别让上一首在后台继续响。
    useEffect(() => {
        if (!enabled || reconciling || isNativePlaybackReconciling()) return;
        if (audioSrc && nativePlaybackEngine.supports(audioSrc)) return;
        void nativePlaybackEngine.stop().catch(() => undefined);
    }, [audioSrc, enabled, reconciling]);

    // 单曲循环随时能按，不能等下一次装地址才生效（那首歌的循环会丢：ExoPlayer 还是
    // OFF，歌放完停在末尾，进度条不动；Web 那条路的 <audio>.loop 是元素属性，React
    // 一渲染就生效，原生这里得显式补一趟）。已经在播的不重新装地址 —— 那会从头再来。
    useEffect(() => {
        if (!enabled || !audioSrc || !nativePlaybackEngine.supports(audioSrc)) return;
        nativePlaybackEngine.setRepeatModeNow(repeatOne ? 1 : 0);
    }, [audioSrc, enabled, repeatOne]);

    // 自动播放。`shouldAutoPlayRef` 由 playSong 置位，Web 那条路（元素有 src 才走）在
    // 原生模式下会因为 src 对不上而自然跳过，所以这里是唯一的消费点。
    useEffect(() => {
        if (!takes || !audioSrc || isLyricsLoading) return;
        if (!shouldAutoPlayRef.current) return;
        shouldAutoPlayRef.current = false;
        nativePlaybackEngine.setVolume(callbacksRef.current.getTargetPlaybackVolume());
        const playIntentGeneration = nativePlaybackEngine.playIntentGeneration();
        const sourceGeneration = nativePlaybackEngine.sourceGeneration();
        const songKey = nativePlaybackEngine.currentSongKey();
        void nativePlaybackEngine.play().then(applied => {
            // 只让当前 source 的起播意图同步状态，避免迟到的结果覆盖恢复、换歌或 ABA 换源。
            // applied === false：这次 play 被原生判为已被取代（例如同一瞬间通知栏暂停），不能写 PLAYING。
            if (
                applied
                && nativePlaybackEngine.playIntentGeneration() === playIntentGeneration + 1
                && nativePlaybackEngine.sourceGeneration() === sourceGeneration
                && nativePlaybackEngine.currentSongKey() === songKey
            ) {
                setPlayerState(PlayerState.PLAYING);
            }
        }).catch((error: unknown) => {
            if (
                nativePlaybackEngine.playIntentGeneration() !== playIntentGeneration + 1
                || nativePlaybackEngine.sourceGeneration() !== sourceGeneration
                || nativePlaybackEngine.currentSongKey() !== songKey
            ) return;
            // 装源失败由 setSource() 那边报，这里不再重复报同一条（#368）。
            if (nativePlaybackEngine.sourceReadyError() === error) return;
            console.error('[NativePlayer] play failed', error);
            callbacksRef.current.onError(String(error));
        });
    }, [audioSrc, isLyricsLoading, shouldAutoPlayRef, takes]);

    // 播放器的事件 → 现有状态机。
    useEffect(() => {
        if (!enabled) return undefined;
        return nativePlaybackEngine.subscribe(event => {
            /*
             * 位置也在这里落一次 —— **只在页面不可见时**。
             *
             * 前台时 rAF 每帧都在写（插值过的、更平滑）。原生现在只在状态边界发事件
             * （没有 250ms 的位置推送），所以后台这一条只在暂停 / 缓冲 / seek / 单曲循环
             * 这类边界上校准；通知栏与锁屏另有自己的取数路径（直接问播放器）。
             */
            const pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            if (pageHidden && typeof event.positionMs === 'number' && event.type !== 'ready') {
                // 走引擎而不是直接写事件里的采样值：引擎那边已经把这一拍的锚点还原到
                // 它真正产生的时刻，直接写采样值会丢掉这段换算。
                currentTime.set(nativePlaybackEngine.getPositionSec());
            }
            switch (event.type) {
                case 'ready':
                    if (typeof event.durationMs === 'number' && event.durationMs > 0) {
                        setDuration(event.durationMs / 1000);
                    }
                    break;
                case 'ended':
                    // 原生服务已经处理 ended 并推进队列；Web 只观察，不能再次 requestSkip。
                    break;
                case 'error':
                    console.error('[NativePlayer] player error', event.message);
                    callbacksRef.current.onError(event.message ?? 'unknown');
                    break;
                default:
                    break;
            }
        });
    }, [enabled]);
};
