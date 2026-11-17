// src/components/app/video/useVideoPlayerActions.ts
// 播放层那些「对视频本体动手」的动作：进度/音量/倍速、逐帧、全屏、画中画、A-B 循环、
// 画面缩放旋转、截图、控制条自动淡出。
//
// 从 useVideoPlayerController 搬出来的原因同样是仓库的单文件 800 行上限；行为逐行未改，
// 只是把这些 useCallback 换了个宿主，依赖通过 deps 传进来。

import React, { useCallback } from 'react';
import { PREFS_KEY, SPEEDS, STEP_SECONDS, CHROME_LINGER_MS, ENHANCE_KEY, clock, writePrefs } from './videoPlayerModel';
import type { AspectMode, Level, LoopMode, PanelTab, Prefs, VideoEpisode } from './videoPlayerModel';

export type VideoPlayerActionsDeps = {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    shellRef: React.RefObject<HTMLDivElement | null>;
    seekBarRef: React.RefObject<HTMLSpanElement | null>;
    hideTimerRef: React.MutableRefObject<number | null>;
    hlsRef: React.MutableRefObject<{ currentLevel: number; levels: Array<{ height: number; bitrate: number }> } | null>;
    levels: Level[];
    setTick: React.Dispatch<React.SetStateAction<{ time: number; duration: number }>>;
    setTip: React.Dispatch<React.SetStateAction<string>>;
    setVolume: React.Dispatch<React.SetStateAction<number>>;
    setPrefs: React.Dispatch<React.SetStateAction<Prefs>>;
    setPlayRate: React.Dispatch<React.SetStateAction<number>>;
    setLevelIndex: React.Dispatch<React.SetStateAction<number>>;
    setEnhance: React.Dispatch<React.SetStateAction<boolean>>;
    setChrome: React.Dispatch<React.SetStateAction<boolean>>;
    setLoopMode: React.Dispatch<React.SetStateAction<LoopMode>>;
    setAb: React.Dispatch<React.SetStateAction<{ a: number | null; b: number | null }>>;
    playRate: number;
    menu: { x: number; y: number } | null;
    panel: PanelTab | null;
    volOpen: boolean;
    helpOpen: boolean;
    playingState: boolean;
    muted: boolean;
    volume: number;
    title: string;
    current?: VideoEpisode;
    index: number;
};

export const useVideoPlayerActions = (deps: VideoPlayerActionsDeps) => {
    const {
    videoRef,
    shellRef,
    seekBarRef,
    hideTimerRef,
    hlsRef,
    levels,
    setTick,
    setTip,
    setVolume,
    setPrefs,
    setPlayRate,
    setLevelIndex,
    setEnhance,
    setChrome,
    setLoopMode,
    setAb,
    playRate,
    menu,
    panel,
    volOpen,
    helpOpen,
    playingState,
    muted,
    volume,
    title,
    current,
    index,
    } = deps;

    /** 把改动一起落到 state 和本地，下次打开还是这套。 */
    const patchPrefs = useCallback((patch: Partial<Prefs>) => {
        setPrefs(prev => {
            const next = { ...prev, ...patch };
            writePrefs(next);
            return next;
        });
    }, []);

    const setVol = useCallback((next: number, announce = true) => {
        const video = videoRef.current;
        const value = Math.min(1, Math.max(0, next));
        if (video) {
            video.volume = value;
            if (value > 0 && video.muted) video.muted = false;
        }
        setVolume(value);
        patchPrefs({ volume: value });
        if (announce) setTip(`音量 ${Math.round(value * 100)}%`);
    }, [patchPrefs]);

    // 进度条按位置点名跳转：点一下到哪儿，按住拖就跟着走。
    const seekTo = useCallback((clientX: number) => {
        const video = videoRef.current;
        const bar = seekBarRef.current;
        if (!video || !bar) return;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        if (!duration) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
        video.currentTime = Math.min(ratio * duration, Math.max(0, duration - 0.2));
        setTick({ time: video.currentTime, duration });
    }, []);

    // 音量滑条：点哪儿调到哪儿，按住拖跟着走。
    const setVolAt = useCallback((clientX: number, el: HTMLElement | null) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setVol(Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))), false);
    }, [setVol]);

    const seekBy = useCallback((delta: number) => {
        const video = videoRef.current;
        if (!video) return;
        const duration = Number.isFinite(video.duration) ? video.duration : video.currentTime + delta;
        video.currentTime = Math.min(Math.max(0, video.currentTime + delta), Math.max(0, duration - 0.2));
        setTip(`${delta > 0 ? '快进' : '快退'} ${Math.abs(Math.round(delta))} 秒`);
    }, []);

    const seekPercent = useCallback((ratio: number) => {
        const video = videoRef.current;
        if (!video) return;
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        if (!duration) return;
        video.currentTime = Math.min(Math.max(0, ratio * duration), Math.max(0, duration - 0.2));
        setTip(`跳到 ${Math.round(ratio * 100)}%`);
    }, []);

    // 逐帧：先暂停，再挪一帧（1/30 秒的近似值，够看字幕、够看动作）。
    const stepFrame = useCallback((direction: 1 | -1) => {
        const video = videoRef.current;
        if (!video) return;
        video.pause();
        const frame = 1 / 30;
        video.currentTime = Math.max(0, video.currentTime + direction * frame);
        setTip(direction > 0 ? '下一帧' : '上一帧');
    }, []);

    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
    }, []);

    const setSpeed = useCallback((rate: number) => {
        const clamped = Math.min(4, Math.max(0.25, Math.round(rate * 100) / 100));
        const video = videoRef.current;
        if (video) video.playbackRate = clamped;
        setPlayRate(clamped);
        patchPrefs({ speed: clamped });
        setTip(`${clamped}× 播放`);
    }, [patchPrefs]);

    const bumpSpeed = useCallback((factor: number) => {
        setSpeed(playRate * factor);
    }, [playRate, setSpeed]);

    const toggleMute = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
        setTip(video.muted ? '静音' : '取消静音');
    }, []);

    const setLevel = useCallback((next: number) => {
        const instance = hlsRef.current;
        if (!instance) return;
        instance.currentLevel = next;
        setLevelIndex(next);
        setTip(next < 0 ? '清晰度：自动' : `清晰度：${levels.find(item => item.index === next)?.height ? `${levels.find(item => item.index === next)?.height}P` : `第 ${next + 1} 档`}`);
    }, [levels]);

    const goFullscreen = useCallback(() => {
        const shell = shellRef.current;
        if (!shell) return;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void shell.requestFullscreen?.().catch(() => setTip('这个窗口不支持全屏'));
    }, []);

    const toggleEnhance = useCallback(() => {
        setEnhance(prev => {
            const next = !prev;
            try {
                window.localStorage.setItem(ENHANCE_KEY, next ? '1' : '0');
            } catch { /* 存不下就只管这一次 */ }
            setTip(next ? '画质增强：开' : '画质增强：关');
            return next;
        });
    }, []);

    const cycleLoop = useCallback(() => {
        setLoopMode(prev => {
            const next: LoopMode = prev === 'off' ? 'episode' : prev === 'episode' ? 'list' : 'off';
            setTip(next === 'off' ? '循环：关' : next === 'episode' ? '循环：单集' : '循环：整个列表');
            return next;
        });
    }, []);

    // A-B 循环：B 键按第一下记起点，第二下记终点，第三下清掉重来。
    const markAB = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        const at = video.currentTime;
        setAb(prev => {
            if (prev.a === null) {
                setTip(`A 点 ${clock(at)}`);
                return { a: at, b: null };
            }
            if (prev.b === null) {
                if (at <= prev.a) {
                    setTip('B 点要在 A 点后面');
                    return prev;
                }
                setTip(`B 点 ${clock(at)} · A-B 循环已开`);
                return { a: prev.a, b: at };
            }
            setTip('A-B 循环已清掉');
            return { a: null, b: null };
        });
    }, []);

    const cycleAspect = useCallback(() => {
        setPrefs(prev => {
            const order: AspectMode[] = ['contain', 'cover', 'fill'];
            const next = order[(order.indexOf(prev.aspect) + 1) % order.length];
            const nextPrefs = { ...prev, aspect: next };
            writePrefs(nextPrefs);
            setTip(next === 'contain' ? '缩放：适应' : next === 'cover' ? '缩放：裁剪铺满' : '缩放：拉伸铺满');
            return nextPrefs;
        });
    }, []);

    const rotatePicture = useCallback(() => {
        setPrefs(prev => {
            const next = { ...prev, rotate: (prev.rotate + 90) % 360 };
            writePrefs(next);
            setTip(`画面旋转 ${next.rotate}°`);
            return next;
        });
    }, []);

    // 截图：把当前这一帧画到 canvas 上，存进下载目录（跨域片源抓不到时如实提示）。
    const shootScreen = useCallback(() => {
        const video = videoRef.current;
        if (!video || !video.videoWidth) {
            setTip('画面还没起来，截不了');
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('canvas 不可用');
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/png');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const link = document.createElement('a');
            link.href = dataUrl;
            link.download = `${title}-${current?.name ?? `第${index + 1}集`}-${stamp}.png`;
            link.click();
            setTip('截图已存到下载目录');
        } catch {
            setTip('这个片源不允许截图（跨域限制）');
        }
    }, [title, current?.name, index]);

    const togglePip = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        try {
            if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
            else void video.requestPictureInPicture?.().catch(() => setTip('这个窗口不支持画中画'));
        } catch {
            setTip('这个窗口不支持画中画');
        }
    }, []);

    // 控制条到点走开：播放中鼠标一停就排一个计时，停下 3 秒淡出；
    // 暂停、右键菜单、右侧面板、音量条、快捷键表任一在场就一直亮着。
    const armHide = useCallback(() => {
        if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            setChrome(false);
        }, CHROME_LINGER_MS);
    }, []);

    const pokeChrome = useCallback(() => {
        setChrome(true);
        if (!playingState || menu || panel || volOpen || helpOpen) return;
        armHide();
    }, [armHide, playingState, menu, panel, volOpen, helpOpen]);

    return {
        patchPrefs,
        setVol,
        seekTo,
        setVolAt,
        seekBy,
        seekPercent,
        stepFrame,
        togglePlay,
        setSpeed,
        bumpSpeed,
        toggleMute,
        setLevel,
        goFullscreen,
        toggleEnhance,
        cycleLoop,
        markAB,
        cycleAspect,
        rotatePicture,
        shootScreen,
        togglePip,
        armHide,
        pokeChrome,
    };
};

export type VideoPlayerActions = ReturnType<typeof useVideoPlayerActions>;
