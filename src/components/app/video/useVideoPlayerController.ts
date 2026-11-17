// src/components/app/video/useVideoPlayerController.ts
// 播放层的全部状态与行为：媒体地址解析、hls 挂载、进度/音量/播放状态、断点续播、快捷键、右键菜单、
// 字幕搜索、画面偏好、退出清理。
//
// 从 VideoPlayer.tsx 搬出来的原因：那个组件文件顶到了仓库 800 行的上限（CI 的 check:size），
// 而它自身已经是一个「状态 + 逻辑」的大块，留在组件里怎么挪都不够。行为与原来逐行一致，只是换了个宿主。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openOutsideLink } from '../../../utils/system/outsideLink';
import { fetchVideoText } from '../../../services/videoSources/net';
import { isMediaUrl } from '../../../services/videoSources/cms';
import { languageName, loadSubtitleVtt, searchSubtitles, type SubtitleHit } from '../../../services/videoSources/subtitles';
import {
    STEP_SECONDS, STEP_SECONDS_LONG, SPEEDS, CHROME_LINGER_MS, PREFS_KEY, ENHANCE_KEY, POS_PREFIX, DEFAULT_PREFS, readPrefs, writePrefs, isHls, resolvePageMedia, clock, KEYMAP,
    buildVideoMenu,
} from './videoPlayerModel';
import { useVideoPlayerActions } from './useVideoPlayerActions';
import type {
    VideoEpisode,
    LoopMode,
    AspectMode,
    Prefs,
    Level,
    PanelTab,
    MenuLeaf,
    MenuBranch,
    MenuEntry,
    VideoPlayerProps,
} from './videoPlayerModel';

export const useVideoPlayerController = (props: VideoPlayerProps) => {
    const { title, cover, lines, lineIndex, onLineChange, episodes, index, onIndexChange, onClose } = props;
    const current: VideoEpisode | undefined = episodes[index];
    const url = current?.url ?? '';

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const hlsRef = useRef<{ currentLevel: number; levels: Array<{ height: number; bitrate: number }> } | null>(null);

    const [error, setError] = useState('');
    const [resolving, setResolving] = useState(false);
    const [mediaUrl, setMediaUrl] = useState(isMediaUrl(url) ? url : '');
    const [failedPage, setFailedPage] = useState(false);
    const [playingState, setPlayingState] = useState(false);
    const [volume, setVolume] = useState(1);
    const [volOpen, setVolOpen] = useState(false);
    const seekBarRef = useRef<HTMLSpanElement | null>(null);
    const seekingRef = useRef(false);
    const volDraggingRef = useRef(false);
    const [muted, setMuted] = useState(false);
    const [tick, setTick] = useState({ time: 0, duration: 0 });
    const [levels, setLevels] = useState<Level[]>([]);
    const [levelIndex, setLevelIndex] = useState(-1);
    const [tip, setTip] = useState('');
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    /** 右键菜单里展开的是哪个分支（按下标记），以及那块子菜单的竖坐标。 */
    const [sub, setSub] = useState<{ at: number; top: number } | null>(null);
    const [panel, setPanel] = useState<PanelTab | null>(null);
    /** 当前倍速：菜单里那一列打勾用。 */
    const [playRate, setPlayRate] = useState(1);
    /** 顶条和底条是亮着还是走开了：播放中鼠标停下几秒就淡出。 */
    const [chrome, setChrome] = useState(true);
    const hideTimerRef = useRef<number | null>(null);
    /** 单击/双击的分辨计时：单击要等一会儿才停/播，免得双击全屏时先暂停一下。 */
    const clickTimerRef = useRef<number | null>(null);
    /** 画质增强：给画面叠一层对比度/饱和度，开关记在本地。 */
    const [enhance, setEnhance] = useState<boolean>(() => {
        try {
            return window.localStorage.getItem(ENHANCE_KEY) === '1';
        } catch {
            return false;
        }
    });
    /** 各方面画面/声音偏好，一次读盘。 */
    const [prefs, setPrefs] = useState<Prefs>(readPrefs);
    /** 循环模式（mpv 的 L 键那一套）。 */
    const [loopMode, setLoopMode] = useState<LoopMode>('off');
    /** A-B 循环的两个点；只有两个都设好才算数。 */
    const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
    /** 缓冲中：中间转一圈，别让画面看着像卡死了。 */
    const [buffering, setBuffering] = useState(false);
    /** 快捷键一览开着没。 */
    const [helpOpen, setHelpOpen] = useState(false);
    /** 播完自动下一集的倒计时秒数。 */
    const [endCount, setEndCount] = useState<number | null>(null);

    // 字幕：搜索词默认为剧名（中文剧名多半搜不到，界面上让改），命中的条目挂在 <track> 上。
    const [subKeyword, setSubKeyword] = useState(title);
    const [subHits, setSubHits] = useState<SubtitleHit[]>([]);
    const [subBusy, setSubBusy] = useState(false);
    const [subNote, setSubNote] = useState('');
    const [subtitleUrl, setSubtitleUrl] = useState('');
    const [subtitleLabel, setSubtitleLabel] = useState('');
    /** 字幕开没开（V 键）。 */
    const [subtitleOn, setSubtitleOn] = useState(true);

    const hasPrev = index > 0;
    const hasNext = index < episodes.length - 1;

    const posKey = useMemo(() => `${POS_PREFIX}:${title}|${current?.name ?? index}`, [title, current?.name, index]);

    // 给的直接就是媒体地址就用它；是播放网页就先去页面里找真地址。
    useEffect(() => {
        setError('');
        setFailedPage(false);
        if (isMediaUrl(url)) {
            setMediaUrl(url);
            setResolving(false);
            return;
        }
        let cancelled = false;
        setMediaUrl('');
        setResolving(true);
        void resolvePageMedia(url).then(media => {
            if (cancelled) return;
            if (media) setMediaUrl(media);
            else setFailedPage(true);
        }).finally(() => {
            if (!cancelled) setResolving(false);
        });
        return () => { cancelled = true; };
    }, [url]);

    useEffect(() => {
        if (!mediaUrl) return;
        const video = videoRef.current;
        if (!video) return;
        if (!isHls(mediaUrl)) {
            setLevels([]);
            video.src = mediaUrl;
            void video.play().catch(() => undefined);
            return () => {
                video.removeAttribute('src');
                video.load();
            };
        }
        let destroyed = false;
        let hls: {
            destroy: () => void;
            currentLevel: number;
            levels: Array<{ height: number; bitrate: number }>;
            on: (event: string, handler: (...args: never[]) => void) => void;
        } | null = null;
        void import('hls.js').then(({ default: Hls }) => {
            if (destroyed || !videoRef.current) return;
            if (!Hls.isSupported()) {
                // 兜底：不支持的平台上让浏览器自己试（部分 Chromium 系能直放）。
                videoRef.current.src = mediaUrl;
                void videoRef.current.play().catch(() => setError('这个平台没有可用的 HLS 解码器。'));
                return;
            }
            const instance = new Hls({ enableWorker: true, lowLatencyMode: false });
            instance.attachMedia(videoRef.current);
            instance.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean; details?: string; type?: string }) => {
                if (!data?.fatal) return;
                setError(`播放中断：${data.details || data.type || '未知错误'}`);
            });
            // master playlist 里每一档（480/720/1080…）报上来，面板上的「清晰度」就是这些。
            instance.on(Hls.Events.MANIFEST_PARSED, () => {
                const raw = (instance.levels ?? []).map((level, at) => ({
                    index: at,
                    height: level.height ?? 0,
                    bitrate: level.bitrate ?? 0,
                }));
                setLevels(raw);
                setLevelIndex(instance.currentLevel ?? -1);
            });
            instance.loadSource(mediaUrl);
            void videoRef.current.play().catch(() => undefined);
            hls = instance as unknown as typeof hls;
            hlsRef.current = instance as unknown as typeof hlsRef.current;
        }).catch(() => setError('hls.js 没能加载，无法在应用内播放 m3u8。'));
        return () => {
            destroyed = true;
            hls?.destroy();
            hlsRef.current = null;
            if (video) {
                video.removeAttribute('src');
                video.load();
            }
        };
    }, [mediaUrl]);

    // 进度、音量、播放状态跟着视频走（原生控制条也在改这些，两边要一致）。
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return undefined;
        const sync = () => setTick({ time: video.currentTime, duration: video.duration });
        const syncVolume = () => { setVolume(video.volume); setMuted(video.muted); };
        const syncPlay = () => setPlayingState(!video.paused && !video.ended);
        const onWaiting = () => setBuffering(true);
        const onReady = () => setBuffering(false);
        video.addEventListener('timeupdate', sync);
        video.addEventListener('durationchange', sync);
        video.addEventListener('volumechange', syncVolume);
        video.addEventListener('play', syncPlay);
        video.addEventListener('pause', syncPlay);
        video.addEventListener('ended', syncPlay);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('stalled', onWaiting);
        video.addEventListener('playing', onReady);
        video.addEventListener('canplay', onReady);
        video.addEventListener('seeked', onReady);
        sync(); syncVolume(); syncPlay();
        return () => {
            video.removeEventListener('timeupdate', sync);
            video.removeEventListener('durationchange', sync);
            video.removeEventListener('volumechange', syncVolume);
            video.removeEventListener('play', syncPlay);
            video.removeEventListener('pause', syncPlay);
            video.removeEventListener('ended', syncPlay);
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('stalled', onWaiting);
            video.removeEventListener('playing', onReady);
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('seeked', onReady);
        };
    }, [mediaUrl]);

    // 画面/声音偏好落到视频本体：音量、倍速、镜像旋转、亮度对比度饱和度、缩放方式。
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.volume = prefs.volume;
        video.playbackRate = prefs.speed;
        setVolume(prefs.volume);
        setPlayRate(prefs.speed);
    }, [prefs, mediaUrl]);

    // 换剧了，字幕搜索词跟着走（用户自己改过就不再覆盖）。
    useEffect(() => { setSubKeyword(title); }, [title]);

    // 提示语自己消失。
    useEffect(() => {
        if (!tip) return undefined;
        const timer = window.setTimeout(() => setTip(''), 1200);
        return () => window.clearTimeout(timer);
    }, [tip]);

    const {
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
    } = useVideoPlayerActions({
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
    });
    useEffect(() => {
        if (!playingState || menu || panel || volOpen || helpOpen) {
            if (hideTimerRef.current) {
                window.clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
            setChrome(true);
            return undefined;
        }
        armHide();
        return () => {
            if (hideTimerRef.current) {
                window.clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
        };
    }, [playingState, menu, panel, volOpen, helpOpen, armHide]);

    // 断点续播：换集/换片时把上次看到的位置接上；看的时候每 5 秒记一次，走的时候再记一次。
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        let restored = false;
        const restore = () => {
            if (restored) return;
            restored = true;
            try {
                const raw = window.localStorage.getItem(posKey);
                const saved = raw ? Number(raw) : 0;
                const duration = Number.isFinite(video.duration) ? video.duration : 0;
                if (saved > 10 && (!duration || saved < duration - 15)) {
                    video.currentTime = saved;
                    setTip(`接着上次看：${clock(saved)}`);
                }
            } catch { /* 读不到就从头 */ }
        };
        const record = () => {
            try {
                window.localStorage.setItem(posKey, String(Math.floor(video.currentTime)));
            } catch { /* 记不下来无妨 */ }
        };
        const onLoaded = () => restore();
        video.addEventListener('loadedmetadata', onLoaded);
        const timer = window.setInterval(() => {
            if (!video.paused) record();
        }, 5000);
        return () => {
            record();
            window.clearInterval(timer);
            video.removeEventListener('loadedmetadata', onLoaded);
        };
    }, [posKey, mediaUrl]);

    // 播完：能下一集就 5 秒倒计时自动续上，列表循环就回头，都不行就停在结尾。
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return undefined;
        const onEnded = () => {
            if (hasNext) { setEndCount(5); return; }
            if (loopMode === 'list' && episodes.length > 1) { onIndexChange(0); return; }
            setEndCount(null);
        };
        video.addEventListener('ended', onEnded);
        return () => video.removeEventListener('ended', onEnded);
    }, [hasNext, loopMode, episodes.length, onIndexChange]);

    useEffect(() => {
        if (endCount === null) return undefined;
        if (endCount <= 0) {
            setEndCount(null);
            if (hasNext) onIndexChange(index + 1);
            return undefined;
        }
        const timer = window.setTimeout(() => setEndCount(value => (value === null ? null : value - 1)), 1000);
        return () => window.clearTimeout(timer);
    }, [endCount, hasNext, index, onIndexChange]);

    // 单集循环交给视频自己，A-B 循环每一帧盯着 B 点。
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.loop = loopMode === 'episode';
    }, [loopMode, mediaUrl]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return undefined;
        const onTime = () => {
            if (ab.a === null || ab.b === null) return;
            if (video.currentTime >= ab.b) video.currentTime = ab.a;
        };
        video.addEventListener('timeupdate', onTime);
        return () => video.removeEventListener('timeupdate', onTime);
    }, [ab]);

    // 滚轮调音量；按住 Shift 滚轮改成快进快退（mpv 的习惯）。
    // React 的 onWheel 在根上是 passive 的，preventDefault 会被忽略，所以直接挂原生监听。
    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            if (event.shiftKey) {
                seekBy(event.deltaY < 0 ? STEP_SECONDS : -STEP_SECONDS);
                return;
            }
            const video = videoRef.current;
            if (!video) return;
            const step = event.deltaY < 0 ? 0.05 : -0.05;
            setVol((Number.isFinite(video.volume) ? video.volume : 1) + step);
        };
        shell.addEventListener('wheel', onWheel, { passive: false });
        return () => shell.removeEventListener('wheel', onWheel);
    }, [seekBy, setVol]);

    // 右键菜单：点别处、按 Esc 就收。
    useEffect(() => {
        if (!menu) return undefined;
        const close = (event: Event) => {
            if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
            setMenu(null);
            setSub(null);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setMenu(null);
            setSub(null);
        };
        window.addEventListener('mousedown', close);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', close);
            window.removeEventListener('keydown', onKey);
        };
    }, [menu]);

    const menuEntries = buildVideoMenu({
        levels,
        levelIndex,
        setLevel,
        playingState,
        togglePlay,
        setPanel,
        mediaUrl,
        url,
        goFullscreen,
        togglePip,
        shootScreen,
        enhance,
        toggleEnhance,
        cycleAspect,
        rotatePicture,
        prefs,
        setPrefs,
        setTip,
        subtitleOn,
        subtitleUrl,
        setSubtitleOn,
        setSubtitleUrl,
        setSubtitleLabel,
        muted,
        toggleMute,
        setVol,
        volume,
        loopMode,
        cycleLoop,
        ab,
        markAB,
        seekBy,
        index,
        onIndexChange,
        hasPrev,
        hasNext,
        setHelpOpen,
        playRate,
        setSpeed,
        bumpSpeed,
        videoRef,
    });

    // 键盘：上面 KEYMAP 那一套，一次挂上。
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

            // Esc 一路往外退：快捷键表 → 右键菜单 → 面板 → 全屏 → 回到选集。
            if (event.key === 'Escape') {
                if (helpOpen) { setHelpOpen(false); return; }
                if (menu) { setMenu(null); setSub(null); return; }
                if (panel) { setPanel(null); return; }
                if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
                onClose();
                return;
            }
            if (event.key === 'F1' || event.key === '?') { event.preventDefault(); setHelpOpen(value => !value); return; }

            // 焦点在按钮/滑条上时，空格是它们自己的（按钮按下、滑条微调）。
            if (target instanceof HTMLElement && target.closest('button, [role="slider"]')) return;

            const key = event.key;
            if (key === ' ') { event.preventDefault(); togglePlay(); return; }
            if (key === 'k' || key === 'K') { togglePlay(); return; }
            if (key === 'ArrowLeft') { event.preventDefault(); seekBy(event.shiftKey ? -STEP_SECONDS_LONG : -STEP_SECONDS); return; }
            if (key === 'ArrowRight') { event.preventDefault(); seekBy(event.shiftKey ? STEP_SECONDS_LONG : STEP_SECONDS); return; }
            if (key === 'j' || key === 'J') { seekBy(-(STEP_SECONDS * 2)); return; }
            if (key === 'l' || key === 'L') { if (event.ctrlKey) return; cycleLoop(); return; }
            if (key === 'ArrowUp') { event.preventDefault(); setVol(volume + 0.05); return; }
            if (key === 'ArrowDown') { event.preventDefault(); setVol(volume - 0.05); return; }
            if (key === 'm' || key === 'M') { toggleMute(); return; }
            if (key === 'f' || key === 'F' || key === 'Enter') { event.preventDefault(); goFullscreen(); return; }
            if (key === 'p' || key === 'P' || key === 'PageUp') { if (hasPrev) onIndexChange(index - 1); return; }
            if (key === 'n' || key === 'N' || key === 'PageDown') { if (hasNext) onIndexChange(index + 1); return; }
            if (key === '[') { bumpSpeed(0.9); return; }
            if (key === ']') { bumpSpeed(1.1); return; }
            if (key === '{') { bumpSpeed(0.5); return; }
            if (key === '}') { bumpSpeed(2); return; }
            if (key === '+') { bumpSpeed(1.1); return; }
            if (key === '-') { bumpSpeed(0.9); return; }
            if (key === 'Backspace') { event.preventDefault(); if (event.shiftKey) setSpeed(1); else seekPercent(0); return; }
            if (key === '.' || key === ',') { stepFrame(key === '.' ? 1 : -1); return; }
            if (key === 'b' || key === 'B') { markAB(); return; }
            if (key === 's' || key === 'S') { shootScreen(); return; }
            if (key === 'v' || key === 'V') { setSubtitleOn(value => !value); setTip(subtitleOn ? '字幕关' : '字幕开'); return; }
            if (key === 'h' || key === 'H') { toggleEnhance(); return; }
            if (key === 'w' || key === 'W') { cycleAspect(); return; }
            if (key === 'r' || key === 'R') { rotatePicture(); return; }
            if (key === 't' || key === 'T') { togglePip(); return; }
            if (key === 'i' || key === 'I') { setPanel(panel === 'more' ? null : 'more'); return; }
            if (key === 'q' || key === 'Q') {
                setPrefs(prev => {
                    const next = { ...prev, aspect: 'contain' as AspectMode, rotate: 0, mirror: false, brightness: 1, contrast: 1, saturation: 1 };
                    writePrefs(next);
                    setTip('画面已恢复默认');
                    return next;
                });
                return;
            }
            if (/^[0-9]$/.test(key)) { seekPercent(Number(key) === 0 ? 0 : Number(key) / 10); return; }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [
        bumpSpeed, cycleAspect, cycleLoop, goFullscreen, hasNext, hasPrev, helpOpen, index, markAB,
        menu, onClose, onIndexChange, panel, rotatePicture, seekBy, seekPercent, setSpeed, setVol,
        shootScreen, stepFrame, subtitleOn, toggleEnhance, toggleMute, togglePip, togglePlay, volume,
    ]);

    // 画面上的点击：单击停/播，双击中间全屏、双击左右两侧各 ±10 秒——跟主流网页播放器 / PotPlayer 一致。
    const handleStageClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        pokeChrome();
        const detail = (event.nativeEvent as MouseEvent).detail;
        if (clickTimerRef.current) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
        if (detail >= 2) {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
            if (ratio < 0.34) seekBy(-(STEP_SECONDS * 2));
            else if (ratio > 0.66) seekBy(STEP_SECONDS * 2);
            else goFullscreen();
            return;
        }
        clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null;
            togglePlay();
        }, 240);
    }, [goFullscreen, pokeChrome, seekBy, togglePlay]);

    useEffect(() => () => {
        if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
        if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    }, []);

    const runSubSearch = useCallback(async () => {
        setSubBusy(true);
        setSubNote('');
        setSubHits([]);
        try {
            const result = await searchSubtitles(subKeyword);
            setSubHits(result.hits);
            setSubNote(result.note);
        } catch (error) {
            setSubNote(error instanceof Error ? error.message : String(error));
        } finally {
            setSubBusy(false);
        }
    }, [subKeyword]);

    const applySubtitle = useCallback(async (hit: SubtitleHit) => {
        setSubNote('正在下载字幕…');
        try {
            const vtt = await loadSubtitleVtt(hit.url);
            const objectUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt;charset=utf-8' }));
            setSubtitleUrl(objectUrl);
            setSubtitleLabel(`${hit.name} · ${languageName(hit.language)}`);
            setSubNote('字幕已挂上。');
        } catch (error) {
            setSubNote(`加载字幕失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }, []);

    const progress = tick.duration > 0 ? Math.min(1, tick.time / tick.duration) : 0;

    const videoFilter = `brightness(${(prefs.brightness * (enhance ? 1.03 : 1)).toFixed(3)}) contrast(${(prefs.contrast * (enhance ? 1.08 : 1)).toFixed(3)}) saturate(${(prefs.saturation * (enhance ? 1.16 : 1)).toFixed(3)})`;
    const videoTransform = `rotate(${prefs.rotate}deg) scaleX(${prefs.mirror ? -1 : 1})`;
    const fitClass = prefs.aspect === 'cover' ? 'object-cover' : prefs.aspect === 'fill' ? 'object-fill' : 'object-contain';
    return {
        ab,
        applySubtitle,
        armHide,
        buffering,
        bumpSpeed,
        chrome,
        clickTimerRef,
        cover,
        current,
        cycleAspect,
        cycleLoop,
        endCount,
        enhance,
        episodes,
        error,
        failedPage,
        fitClass,
        goFullscreen,
        handleStageClick,
        hasNext,
        hasPrev,
        helpOpen,
        hideTimerRef,
        hlsRef,
        index,
        levelIndex,
        levels,
        lineIndex,
        lines,
        loopMode,
        markAB,
        mediaUrl,
        menu,
        menuEntries,
        menuRef,
        muted,
        onClose,
        onIndexChange,
        onLineChange,
        panel,
        patchPrefs,
        playRate,
        playingState,
        pokeChrome,
        posKey,
        prefs,
        progress,
        resolving,
        rotatePicture,
        runSubSearch,
        seekBarRef,
        seekBy,
        seekPercent,
        seekTo,
        seekingRef,
        setAb,
        setBuffering,
        setChrome,
        setEndCount,
        setEnhance,
        setError,
        setFailedPage,
        setHelpOpen,
        setLevel,
        setLevelIndex,
        setLevels,
        setLoopMode,
        setMediaUrl,
        setMenu,
        setMuted,
        setPanel,
        setPlayRate,
        setPlayingState,
        setPrefs,
        setResolving,
        setSpeed,
        setSub,
        setSubBusy,
        setSubHits,
        setSubKeyword,
        setSubNote,
        setSubtitleLabel,
        setSubtitleOn,
        setSubtitleUrl,
        setTick,
        setTip,
        setVol,
        setVolAt,
        setVolOpen,
        setVolume,
        shellRef,
        shootScreen,
        stepFrame,
        sub,
        subBusy,
        subHits,
        subKeyword,
        subNote,
        subtitleLabel,
        subtitleOn,
        subtitleUrl,
        tick,
        tip,
        title,
        toggleEnhance,
        toggleMute,
        togglePip,
        togglePlay,
        url,
        videoFilter,
        videoRef,
        videoTransform,
        volDraggingRef,
        volOpen,
        volume,
    };
};

export type VideoPlayerController = ReturnType<typeof useVideoPlayerController>;
