// src/components/app/video/VideoPlayer.tsx
// 影视的播放层：全屏沉浸的一层，照 Folia 自己的播放页来——大封面、底部那条控制条、右侧一块页签面板。
//
// 与音乐播放页的区别只在内容：这里的「封面」是剧集海报，「播放列表」里的条目是一集一集，
// 「音质」那个位置换成了「清晰度」（片源是 m3u8，档位来自 master playlist；单档源就说明只有一档，
// 换线路就是换片源清晰度）。
//
// m3u8 用 hls.js（动态 import，只有真点进一集时才拉这个 chunk）；mp4 之类直链直接交给 <video>。
// 影视站常见的 svip/share 播放网页不是媒体直链，这里先去这个网页里把真正的 m3u8 抠出来。
//
// 操作面是把几家主流播放器的习惯合成一套（不另起一套键位）：
//   PotPlayer —— 空格停/播、←/→ 5 秒、↑/↓ 音量、Enter 全屏、PgUp/PgDn 上下集、/ - 调倍速、B 设 A-B、C 载图
//   mpv       —— , . 逐帧、[ ] 倍速 ∓10%、{ } 减半/加倍、L 循环、数字键跳百分比、滚轮音量
//   YouTube   —— 单击画面停/播、双击全屏、双击左右两侧快退/快进、J/K/L、M 静音
//   IINA/Infuse —— 断点续播、自动下一集、结尾倒计时
// 画面走 Folia 的液态玻璃：海报虚化打底 + 环境光，控制条是一条玻璃胶囊，播放中鼠标停下几秒自己走开。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Camera,
    Check,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    HelpCircle,
    ListMusic,
    Maximize2,
    Pause,
    PictureInPicture2,
    Play,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    Settings2,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
} from 'lucide-react';
import { openOutsideLink } from '../../../utils/system/outsideLink';
import { fetchVideoText } from '../../../services/videoSources/net';
import { isMediaUrl, type CmsPlayLine } from '../../../services/videoSources/cms';
import { languageName, loadSubtitleVtt, searchSubtitles, type SubtitleHit } from '../../../services/videoSources/subtitles';

export type VideoEpisode = { name: string; url: string };

type Props = {
    /** 剧名。 */
    title: string;
    /** 剧集海报，做这一层的封面/背景。 */
    cover?: string;
    /** 这一部剧的所有线路（换线路等于换片源，也就是换清晰度）。 */
    lines: CmsPlayLine[];
    /** 当前线路下标。 */
    lineIndex: number;
    /** 换线路。 */
    onLineChange: (index: number) => void;
    /** 当前线路的可选集。 */
    episodes: VideoEpisode[];
    /** 正在播的是第几集。 */
    index: number;
    /** 换集。 */
    onIndexChange: (index: number) => void;
    onClose: () => void;
};

/** 基础快进快退步长：跟 PotPlayer / mpv 的 5 秒一致，Shift 跳到 30 秒。 */
const STEP_SECONDS = 5;
const STEP_SECONDS_LONG = 30;
const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
/** 控制条亮着多久就走开（毫秒）。 */
const CHROME_LINGER_MS = 3000;
/** 画质增强与各项画面偏好的存储键。 */
const PREFS_KEY = 'folia-video-prefs';
const ENHANCE_KEY = 'folia-video-enhance';
/** 断点续播的存储键前缀。 */
const POS_PREFIX = 'folia-video-pos';

type LoopMode = 'off' | 'episode' | 'list';
type AspectMode = 'contain' | 'cover' | 'fill';

/** 记在本地的一整套画面/声音偏好。 */
type Prefs = {
    volume: number;
    speed: number;
    aspect: AspectMode;
    rotate: number;
    mirror: boolean;
    brightness: number;
    contrast: number;
    saturation: number;
};

const DEFAULT_PREFS: Prefs = {
    volume: 1,
    speed: 1,
    aspect: 'contain',
    rotate: 0,
    mirror: false,
    brightness: 1,
    contrast: 1,
    saturation: 1,
};

const readPrefs = (): Prefs => {
    try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        return { ...DEFAULT_PREFS, ...parsed };
    } catch {
        return { ...DEFAULT_PREFS };
    }
};

const writePrefs = (prefs: Prefs) => {
    try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* 存不进就只管这一次 */ }
};

const isHls = (url: string) => /\.m3u8($|\?)/i.test(url);

/** 从一个播放网页里抠出真正的媒体地址；抠不到返回空串。 */
const resolvePageMedia = async (pageUrl: string): Promise<string> => {
    try {
        const response = await fetchVideoText(pageUrl);
        if (!response.ok) return '';
        const match = response.bodyText.match(/["'(]([^"'()\\\s]*\.m3u8[^"'()\\\s]*)/i);
        if (!match) return '';
        // 页面里常给相对路径（/20250923/xxx/index.m3u8?sign=…），按页面地址补成绝对地址。
        try {
            return new URL(match[1], pageUrl).toString();
        } catch {
            return '';
        }
    } catch {
        return '';
    }
};

const clock = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (value: number) => String(value).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};

/** hls.js 报上来的档位。 */
type Level = { index: number; height: number; bitrate: number };

type PanelTab = 'cover' | 'episodes' | 'subtitle' | 'quality' | 'more';

/** 右键菜单的一条：能点的叶子、带子菜单的分支、或者一道分隔线。 */
type MenuLeaf = { kind: 'leaf'; label: string; hint?: string; checked?: boolean; disabled?: boolean; run: () => void };
type MenuBranch = { kind: 'branch'; label: string; children: MenuLeaf[] };
type MenuEntry = MenuLeaf | MenuBranch | { kind: 'line' };

/** 快捷键一览（F1 打开）：菜单里标的键位和这里是同一份。 */
const KEYMAP: Array<[string, string]> = [
    ['空格 / K', '播放·暂停'],
    ['← / →', '快退·快进 5 秒（Shift 30 秒）'],
    ['J / L', '快退·快进 10 秒'],
    ['↑ / ↓', '音量 +/− 5%'],
    ['M', '静音切换'],
    ['滚轮', '调音量（Shift+滚轮 快进·快退）'],
    ['单击画面', '播放·暂停（双击左右两侧各 ±10 秒）'],
    ['双击画面', '全屏 / 退出全屏'],
    ['F / Enter', '全屏 / 退出全屏'],
    ['Esc', '逐级返回：菜单 → 面板 → 全屏 → 选集'],
    ['P / N (PgUp·PgDn)', '上一集 · 下一集'],
    ['[ / ]', '倍速 ∓10%'],
    ['{ / }', '倍速减半 / 加倍'],
    ['Backspace', '回到片头（Shift 恢复 1× 倍速）'],
    [', / .', '逐帧后退 / 前进'],
    ['1–9 / 0', '跳到 10%–90% / 片头'],
    ['L', '循环：关 → 单集 → 列表'],
    ['B', '按一下设起点 A，再按一下设终点 B（A-B 循环）'],
    ['S', '截图（存下载目录）'],
    ['V', '字幕开关'],
    ['H', '画质增强'],
    ['W', '缩放：适应 → 铺满 → 裁剪'],
    ['R', '画面旋转 90°'],
    ['T', '画中画（浮在最上层的小窗）'],
    ['I', '媒体信息面板'],
    ['F1 / ?', '这份快捷键一览'],
];

export const VideoPlayer: React.FC<Props> = ({
    title,
    cover,
    lines,
    lineIndex,
    onLineChange,
    episodes,
    index,
    onIndexChange,
    onClose,
}) => {
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

    // 右键菜单：照影视播放器那种排法——一列到底，几道细线分组，带子菜单的右边一个箭头，
    // 开关类的左边一个勾，键位提示贴在右边。子菜单是一种「第二列」，点进去还有一层。
    const qualityChildren: MenuLeaf[] = levels.length > 0
        ? [
            { kind: 'leaf', label: '自动', checked: levelIndex < 0, run: () => setLevel(-1) },
            ...levels.map(level => ({
                kind: 'leaf' as const,
                label: level.height ? `${level.height}P` : `第 ${level.index + 1} 档`,
                hint: level.bitrate ? `${Math.round(level.bitrate / 1000)}kbps` : undefined,
                checked: levelIndex === level.index,
                run: () => setLevel(level.index),
            })),
        ]
        : [{ kind: 'leaf', label: '这个片源只有一档', disabled: true, run: () => undefined }];

    const speedChildren: MenuLeaf[] = [
        ...SPEEDS.map(rate => ({
            kind: 'leaf' as const,
            label: `${rate}× 倍速`,
            checked: Math.abs(playRate - rate) < 0.01,
            run: () => setSpeed(rate),
        })),
        { kind: 'leaf', label: '慢一点 −10%', hint: '[', run: () => bumpSpeed(0.9) },
        { kind: 'leaf', label: '快一点 +10%', hint: ']', run: () => bumpSpeed(1.1) },
        { kind: 'leaf', label: '恢复 1×', hint: 'Shift+⌫', run: () => setSpeed(1) },
        { kind: 'leaf', label: '回到片头', hint: '⌫', run: () => { const video = videoRef.current; if (video) video.currentTime = 0; } },
    ];

    const menuEntries: MenuEntry[] = [
        { kind: 'leaf', label: playingState ? '暂停' : '播放', hint: '空格', run: togglePlay },
        {
            kind: 'branch',
            label: '打开',
            children: [
                { kind: 'leaf', label: '选集 / 播放列表', hint: 'F6', run: () => setPanel('episodes') },
                { kind: 'leaf', label: '清晰度', run: () => setPanel('quality') },
                { kind: 'leaf', label: '搜索全网字幕…', run: () => setPanel('subtitle') },
                { kind: 'leaf', label: '用浏览器打开', run: () => { void openOutsideLink(mediaUrl || url); } },
            ],
        },
        { kind: 'leaf', label: document.fullscreenElement ? '退出全屏' : '全屏', hint: 'F', run: goFullscreen },
        { kind: 'leaf', label: '画中画', hint: 'T', run: togglePip },
        { kind: 'leaf', label: '截图', hint: 'S', run: shootScreen },
        { kind: 'line' },
        {
            kind: 'branch',
            label: '画面',
            children: [
                { kind: 'leaf', label: '画质增强', hint: 'H', checked: enhance, run: toggleEnhance },
                { kind: 'leaf', label: '缩放方式', hint: 'W', run: cycleAspect },
                { kind: 'leaf', label: `旋转画面 90°`, hint: 'R', run: rotatePicture },
                {
                    kind: 'leaf',
                    label: '左右镜像',
                    checked: prefs.mirror,
                    run: () => {
                        setPrefs(prev => {
                            const next = { ...prev, mirror: !prev.mirror };
                            writePrefs(next);
                            setTip(next.mirror ? '左右镜像：开' : '左右镜像：关');
                            return next;
                        });
                    },
                },
                {
                    kind: 'leaf',
                    label: '画面重置',
                    hint: 'Q',
                    run: () => {
                        setPrefs(prev => {
                            const next = { ...prev, aspect: 'contain' as AspectMode, rotate: 0, mirror: false, brightness: 1, contrast: 1, saturation: 1 };
                            writePrefs(next);
                            setTip('画面已恢复默认');
                            return next;
                        });
                    },
                },
                { kind: 'leaf', label: '清晰度档位', run: () => setPanel('quality') },
                ...qualityChildren.slice(0, 1),
            ],
        },
        {
            kind: 'branch',
            label: '字幕',
            children: [
                { kind: 'leaf', label: '字幕开关', hint: 'V', checked: subtitleOn && !!subtitleUrl, run: () => { setSubtitleOn(value => !value); setTip(subtitleOn ? '字幕关' : '字幕开'); } },
                { kind: 'leaf', label: '搜索全网字幕…', run: () => setPanel('subtitle') },
                {
                    kind: 'leaf',
                    label: '关闭字幕',
                    disabled: !subtitleUrl,
                    run: () => { setSubtitleUrl(''); setSubtitleLabel(''); setTip('字幕已关闭'); },
                },
            ],
        },
        {
            kind: 'branch',
            label: '声音',
            children: [
                { kind: 'leaf', label: '静音', hint: 'M', checked: muted, run: toggleMute },
                { kind: 'leaf', label: '音量 +5%', hint: '↑', run: () => setVol(volume + 0.05) },
                { kind: 'leaf', label: '音量 −5%', hint: '↓', run: () => setVol(volume - 0.05) },
                { kind: 'leaf', label: `音量 ${Math.round(volume * 100)}%`, disabled: true, run: () => undefined },
            ],
        },
        { kind: 'branch', label: '播放', children: speedChildren },
        {
            kind: 'leaf',
            label: loopMode === 'off' ? '循环：关' : loopMode === 'episode' ? '循环：单集' : '循环：列表',
            hint: 'L',
            run: cycleLoop,
        },
        { kind: 'leaf', label: ab.b === null ? '设 A-B 循环起点' : '清掉 A-B 循环', hint: 'B', checked: ab.b !== null, run: markAB },
        { kind: 'line' },
        { kind: 'leaf', label: `快退 ${STEP_SECONDS} 秒`, hint: '←', run: () => seekBy(-STEP_SECONDS) },
        { kind: 'leaf', label: `快进 ${STEP_SECONDS} 秒`, hint: '→', run: () => seekBy(STEP_SECONDS) },
        { kind: 'leaf', label: '上一集', hint: 'P', run: () => { if (hasPrev) onIndexChange(index - 1); }, disabled: !hasPrev },
        { kind: 'leaf', label: '下一集', hint: 'N', run: () => { if (hasNext) onIndexChange(index + 1); }, disabled: !hasNext },
        { kind: 'line' },
        { kind: 'leaf', label: '媒体信息', hint: 'I', run: () => setPanel('more') },
        { kind: 'leaf', label: '快捷键一览', hint: 'F1', run: () => setHelpOpen(true) },
        { kind: 'leaf', label: '设置…', run: () => setPanel('cover') },
    ];

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

    // 画面上的点击：单击停/播，双击中间全屏、双击左右两侧各 ±10 秒——跟 YouTube / PotPlayer 一致。
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

    return (
        <div
            ref={shellRef}
            data-video-player
            className="fixed inset-0 z-[90] flex min-h-0 select-none flex-col overflow-hidden bg-[#07070a]"
            onMouseMove={pokeChrome}
            onContextMenu={event => {
                event.preventDefault();
                const width = 214;
                // 一列到底：一行 28px，分隔线各占 8px，再加内边距。
                const rows = menuEntries.reduce((sum, entry) => sum + (entry.kind === 'line' ? 8 : 28), 0) + 8;
                const height = Math.min(rows, 470);
                const x = Math.min(event.clientX, window.innerWidth - width - 8);
                const y = Math.min(event.clientY, Math.max(8, window.innerHeight - height - 8));
                setSub(null);
                setMenu({ x, y });
            }}
        >
            {/* 顶条：返回、剧名、音量提示、画中画、全屏。播放中会跟底条一起淡出。 */}
            <div
                className={`absolute left-0 right-0 top-0 z-20 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-2 transition-opacity duration-300 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10"
                    title="返回选集（Esc）"
                    aria-label="返回选集"
                >
                    <ChevronLeft size={18} />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-[#f2f2f4]">{title}</div>
                    <div className="truncate text-[11.5px] text-[#f2f2f4]/50">
                        {current?.name ?? ''}{episodes.length > 1 ? ` · 第 ${index + 1}/${episodes.length} 集` : ''}
                        {lines[lineIndex]?.name ? ` · ${lines[lineIndex].name}` : ''}
                        {enhance ? ' · 画质增强' : ''}
                        {loopMode !== 'off' ? (loopMode === 'episode' ? ' · 单集循环' : ' · 列表循环') : ''}
                        {ab.b !== null ? ` · A-B ${clock(ab.a ?? 0)}–${clock(ab.b)}` : ''}
                    </div>
                </div>
                {tip && <span className="shrink-0 rounded-md bg-white/12 px-2 py-1 text-[11.5px] text-[#f2f2f4]">{tip}</span>}
                <button type="button" onClick={togglePip} title="画中画（T）" aria-label="画中画" className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10">
                    <PictureInPicture2 size={16} />
                </button>
                <button type="button" onClick={() => setHelpOpen(true)} title="快捷键一览（F1）" aria-label="快捷键一览" className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10">
                    <HelpCircle size={16} />
                </button>
                <button type="button" onClick={goFullscreen} title="全屏（F）" aria-label="全屏" className="rounded-full p-1.5 text-[#f2f2f4] hover:bg-white/10">
                    <Maximize2 size={16} />
                </button>
            </div>

            {/* 画面：视频铺满；还没起来就放海报，别一片黑。 */}
            <div className="relative min-h-0 flex-1">
                {/* 液态玻璃底：海报虚化 + 环境光，黑色只压在四周，中间留出画面。 */}
                <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                    {cover ? (
                        <img
                            src={cover}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-[70px] saturate-150"
                        />
                    ) : null}
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_18%,rgba(111,91,240,0.18),transparent_62%)]" />
                    <div className="absolute inset-0 bg-gradient-to-b from-[#07070a]/70 via-[#07070a]/45 to-[#07070a]/85" />
                </div>

                {mediaUrl ? (
                    <video
                        ref={videoRef}
                        controls={false}
                        autoPlay
                        playsInline
                        className={`relative h-full w-full bg-transparent ${fitClass}`}
                        style={{ filter: videoFilter, transform: videoTransform }}
                    >
                        {subtitleUrl && subtitleOn && (
                            <track key={subtitleUrl} kind="subtitles" src={subtitleUrl} default label={subtitleLabel || '字幕'} srcLang="zh" />
                        )}
                    </video>
                ) : (
                    <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
                        {cover && (
                            <img src={cover} alt="" referrerPolicy="no-referrer" className="max-h-[52%] rounded-xl object-contain opacity-60" />
                        )}
                        {resolving ? (
                            <p className="text-[13px] text-[#f2f2f4]/70">正在解析这一集的播放地址…</p>
                        ) : (
                            <>
                                <p className="max-w-[460px] text-[13px] leading-6 text-[#f2f2f4]/70">
                                    这一集这个站点只给了播放网页，页面里没找到能直接播的地址。换个线路试试，或者用浏览器打开。
                                </p>
                                <button
                                    type="button"
                                    onClick={() => { void openOutsideLink(url); }}
                                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#6f5bf0] px-3 py-1.5 text-[13px] font-medium text-white"
                                >
                                    <ExternalLink size={15} />
                                    用浏览器打开
                                </button>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="text-[12.5px] text-[#f2f2f4]/60 underline underline-offset-2 hover:text-[#f2f2f4]"
                                >
                                    回去换线路
                                </button>
                            </>
                        )}
                    </div>
                )}

                {/* 画面点击层：单击停/播，双击中间全屏、双击左右 ±10 秒。 */}
                <div onClick={handleStageClick} className="absolute inset-0 z-10" aria-hidden="true" />

                {/* 缓冲中转一圈。 */}
                {buffering && mediaUrl ? (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                        <span className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white/75" />
                    </div>
                ) : null}

                {/* 停下来的时候中间给一颗大播放钮，点一下接着看（跟 Folia 播放页一个意思）。 */}
                {!playingState && mediaUrl && !buffering ? (
                    <button
                        type="button"
                        onClick={togglePlay}
                        aria-label="播放"
                        className="absolute left-1/2 top-1/2 z-10 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-[#f2f2f4] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md transition-transform hover:scale-105"
                    >
                        <Play size={26} className="translate-x-[2px]" />
                    </button>
                ) : null}

                {/* 播完：能续就倒计时自动下一集。 */}
                {endCount !== null && hasNext ? (
                    <div className="absolute bottom-24 right-6 z-20 flex w-[240px] flex-col gap-2 rounded-2xl border border-white/10 bg-black/60 p-3 backdrop-blur-xl">
                        <div className="truncate text-[12.5px] text-[#f2f2f4]/70">本章播完，{endCount} 秒后继续</div>
                        <button
                            type="button"
                            onClick={() => { setEndCount(null); onIndexChange(index + 1); }}
                            className="rounded-xl bg-white/12 px-3 py-1.5 text-[13px] font-medium text-[#f2f2f4] hover:bg-white/18"
                        >
                            立即播放第 {index + 2} 集
                        </button>
                        <button type="button" onClick={() => setEndCount(null)} className="text-[11.5px] text-[#f2f2f4]/45 hover:text-[#f2f2f4]/80">
                            停在这儿
                        </button>
                    </div>
                ) : null}

                {/* 底部控制条：一颗圆钮 + 上一集/下一集 + 剧名与集数 + 进度 + 列表 + 齿轮。 */}
                <div
                    className={`absolute bottom-3 left-1/2 z-20 w-[min(92%,980px)] -translate-x-1/2 transition-opacity duration-300 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                >
                    <div className="flex items-center gap-3 rounded-[22px] border border-white/12 bg-black/55 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-xl">
                        <button
                            type="button"
                            onClick={togglePlay}
                            aria-label={playingState ? '暂停' : '播放'}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f2f2f4] text-[#0a0a0c] transition-transform hover:scale-[1.04]"
                        >
                            {playingState ? <Pause size={18} /> : <Play size={18} />}
                        </button>
                        <button
                            type="button"
                            disabled={!hasPrev}
                            onClick={() => onIndexChange(index - 1)}
                            title="上一集（P）"
                            className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4] disabled:opacity-30"
                        >
                            <SkipBack size={16} />
                        </button>
                        <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
                            <span className="w-full truncate text-center text-[13px] font-medium text-[#f2f2f4]">{title}</span>
                            {/* 进度条自己是可点可拖的，不再包在选集按钮里，否则点一下只会弹面板。 */}
                            <span
                                ref={seekBarRef}
                                role="slider"
                                tabIndex={-1}
                                aria-label="播放进度"
                                aria-valuemin={0}
                                aria-valuemax={Math.round(tick.duration)}
                                aria-valuenow={Math.round(tick.time)}
                                onPointerDown={event => {
                                    seekingRef.current = true;
                                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 指针捕获不可用就退化到普通移动 */ }
                                    seekTo(event.clientX);
                                }}
                                onPointerMove={event => { if (seekingRef.current) seekTo(event.clientX); }}
                                onPointerUp={event => {
                                    seekingRef.current = false;
                                    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
                                }}
                                onPointerCancel={() => { seekingRef.current = false; }}
                                className="group relative block h-3.5 w-full cursor-pointer touch-none select-none"
                            >
                                <span className="absolute inset-x-0 top-1/2 block h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/15">
                                    <span className="absolute inset-y-0 left-0 rounded-full bg-[#56c98d]" style={{ width: `${progress * 100}%` }} />
                                    {ab.b !== null && tick.duration > 0 ? (
                                        <span
                                            className="absolute inset-y-0 rounded-full bg-[#e3a949]/70"
                                            style={{ left: `${((ab.a ?? 0) / tick.duration) * 100}%`, width: `${Math.max(0, ((ab.b - (ab.a ?? 0)) / tick.duration) * 100)}%` }}
                                        />
                                    ) : null}
                                </span>
                                <span
                                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2f2f4] opacity-0 transition-opacity group-hover:opacity-100"
                                    style={{ left: `${progress * 100}%` }}
                                />
                            </span>
                            <span className="flex w-full items-center justify-between text-[11px] tabular-nums text-[#f2f2f4]/55">
                                <span>{clock(tick.time)}</span>
                                <span className="truncate px-2">
                                    {episodes.length > 1 ? `第 ${index + 1}/${episodes.length} 集` : current?.name ?? ''}
                                    {playRate !== 1 ? ` · ${playRate}×` : ''}
                                </span>
                                <span>{clock(tick.duration)}</span>
                            </span>
                        </div>
                        <button
                            type="button"
                            disabled={!hasNext}
                            onClick={() => onIndexChange(index + 1)}
                            title="下一集（N）"
                            className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4] disabled:opacity-30"
                        >
                            <SkipForward size={16} />
                        </button>
                        <span className="h-5 w-px bg-white/15" aria-hidden="true" />
                        <span className="relative shrink-0">
                            <button
                                type="button"
                                onClick={() => { if (muted) toggleMute(); setVolOpen(open => !open); }}
                                onDoubleClick={toggleMute}
                                title={muted ? '取消静音（双击切换静音）' : '静音（双击切换静音）'}
                                className="rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4]"
                            >
                                {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                            </button>
                            {volOpen && (
                                <span className="absolute bottom-9 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-2 backdrop-blur">
                                    <span
                                        role="slider"
                                        aria-label="音量"
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
                                        onPointerDown={event => {
                                            volDraggingRef.current = true;
                                            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 退化 */ }
                                            setVolAt(event.clientX, event.currentTarget);
                                        }}
                                        onPointerMove={event => { if (volDraggingRef.current) setVolAt(event.clientX, event.currentTarget); }}
                                        onPointerUp={event => {
                                            volDraggingRef.current = false;
                                            try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
                                        }}
                                        onPointerCancel={() => { volDraggingRef.current = false; }}
                                        className="relative block h-3 w-24 cursor-pointer touch-none select-none"
                                    >
                                        <span className="absolute inset-x-0 top-1/2 block h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
                                            <span className="absolute inset-y-0 left-0 rounded-full bg-[#56c98d]" style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
                                        </span>
                                        <span
                                            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2f2f4]"
                                            style={{ left: `${(muted ? 0 : volume) * 100}%` }}
                                        />
                                    </span>
                                    <span className="w-8 text-[11px] tabular-nums text-[#f2f2f4]/70">{Math.round((muted ? 0 : volume) * 100)}%</span>
                                </span>
                            )}
                        </span>
                        <button
                            type="button"
                            onClick={() => setPanel('episodes')}
                            title="播放列表（选集）"
                            className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4]"
                        >
                            <ListMusic size={16} />
                        </button>
                        <button
                            type="button"
                            onClick={() => setPanel(panel ? null : 'cover')}
                            title="播放面板"
                            className="shrink-0 rounded-full p-1.5 text-[#f2f2f4]/80 hover:text-[#f2f2f4]"
                        >
                            <Settings2 size={16} />
                        </button>
                    </div>
                </div>
            </div>

            {/* 右侧面板：封面 / 选集 / 字幕 / 清晰度 / 更多。 */}
            {panel && (
                <div className="absolute bottom-3 right-3 top-14 z-30 flex w-[min(78vw,340px)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#141418]/95 backdrop-blur">
                    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
                        {cover && <img src={cover} alt="" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded-md object-cover" />}
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-[12.5px] font-medium text-[#f2f2f4]">{title}</div>
                            <div className="truncate text-[11px] text-[#f2f2f4]/45">{current?.name ?? ''}</div>
                        </div>
                        <button type="button" onClick={() => setPanel(null)} className="shrink-0 rounded-full p-1 text-[#f2f2f4]/70 hover:bg-white/10 hover:text-[#f2f2f4]" aria-label="关闭面板">
                            ✕
                        </button>
                    </div>

                    <div className="tabs flex shrink-0 gap-1 px-2 pt-2">
                        {([['cover', '封面'], ['episodes', '选集'], ['subtitle', '字幕'], ['quality', '清晰度'], ['more', '更多']] as Array<[PanelTab, string]>).map(([key, label]) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setPanel(key)}
                                className={`rounded-lg px-2.5 py-1 text-[12px] ${panel === key ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/50 hover:text-[#f2f2f4]'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-3">
                        {panel === 'cover' && (
                            <div className="flex flex-col items-stretch gap-2">
                                {cover ? (
                                    <img src={cover} alt="" referrerPolicy="no-referrer" className="w-full rounded-xl object-cover" />
                                ) : (
                                    <div className="flex h-48 items-center justify-center rounded-xl bg-white/5 text-[12px] text-[#f2f2f4]/35">没有海报</div>
                                )}
                                <div className="text-[13px] font-semibold text-[#f2f2f4]">{title}</div>
                                <div className="text-[11.5px] text-[#f2f2f4]/45">{current?.name ?? ''}</div>
                                <div className="text-[11.5px] leading-5 text-[#f2f2f4]/35">
                                    片源：{lines[lineIndex]?.name ?? '内置源'} · 共 {episodes.length} 集
                                </div>
                            </div>
                        )}

                        {panel === 'episodes' && (
                            <div className="flex flex-col gap-1">
                                <div className="mb-1 flex items-center justify-between text-[11.5px] text-[#f2f2f4]/45">
                                    <span>选集 {episodes.length}</span>
                                    <span>当前第 {index + 1} 集</span>
                                </div>
                                {episodes.map((episode, at) => (
                                    <button
                                        key={`${episode.name}-${at}`}
                                        type="button"
                                        onClick={() => onIndexChange(at)}
                                        className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] ${at === index ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]'}`}
                                    >
                                        <span className="truncate">{episode.name}</span>
                                        <span className="shrink-0 text-[11px] tabular-nums text-[#f2f2f4]/35">{String(at + 1).padStart(2, '0')}</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {panel === 'subtitle' && (
                            <div className="flex flex-col gap-2">
                                <div className="text-[11.5px] leading-4 text-[#f2f2f4]/45">
                                    搜全网字幕（OpenSubtitles）。中文剧名多半搜不到，换成英文名或拼音更准——庆余年 就是 qing yu nian 或 Joy of Life。
                                </div>
                                <div className="flex gap-1.5">
                                    <input
                                        value={subKeyword}
                                        onChange={event => setSubKeyword(event.target.value)}
                                        onKeyDown={event => { if (event.key === 'Enter') void runSubSearch(); }}
                                        placeholder="剧名 / 英文名 / 拼音"
                                        className="h-8 min-w-0 flex-1 select-text rounded-lg bg-white/10 px-2.5 text-[12.5px] text-[#f2f2f4] outline-none placeholder:text-[#f2f2f4]/35"
                                    />
                                    <button
                                        type="button"
                                        disabled={subBusy}
                                        onClick={() => void runSubSearch()}
                                        className="h-8 shrink-0 rounded-lg bg-[#6f5bf0] px-2.5 text-[12px] font-medium text-white disabled:opacity-40"
                                    >
                                        {subBusy ? '搜索中…' : '搜索'}
                                    </button>
                                </div>
                                {subNote && <div className="text-[11.5px] leading-4 text-[#e3a949]">{subNote}</div>}
                                {subtitleUrl && (
                                    <div className="flex items-center justify-between gap-2 rounded-lg bg-white/10 px-2.5 py-1.5 text-[12px] text-[#f2f2f4]">
                                        <span className="min-w-0 truncate">已加载：{subtitleLabel}</span>
                                        <button
                                            type="button"
                                            onClick={() => { setSubtitleUrl(''); setSubtitleLabel(''); }}
                                            className="shrink-0 text-[11.5px] text-[#f2f2f4]/60 hover:text-[#f2f2f4]"
                                        >
                                            关闭字幕
                                        </button>
                                    </div>
                                )}
                                <div className="flex flex-col gap-1">
                                    {subHits.map(hit => {
                                        const matched = hit.episode === index + 1;
                                        return (
                                            <button
                                                key={hit.id}
                                                type="button"
                                                onClick={() => void applySubtitle(hit)}
                                                className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${matched ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/60 hover:bg-white/8 hover:text-[#f2f2f4]'}`}
                                            >
                                                <span className="min-w-0 truncate">
                                                    {matched && <span className="mr-1 text-[#56c98d]">当前集</span>}
                                                    {hit.name}
                                                </span>
                                                <span className="shrink-0 text-[10.5px] text-[#f2f2f4]/40">
                                                    {languageName(hit.language)}{hit.downloads ? ` · ${hit.downloads}` : ''}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {panel === 'quality' && (
                            <div className="flex flex-col gap-2">
                                <div className="text-[11.5px] text-[#f2f2f4]/45">当前：{lines[lineIndex]?.name ?? '内置源'}</div>
                                {levels.length > 0 ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => setLevel(-1)}
                                            className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] ${levelIndex < 0 ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8'}`}
                                        >
                                            <span>自动</span>
                                            {levelIndex < 0 && <span className="text-[#56c98d]">✓</span>}
                                        </button>
                                        {levels.map(level => (
                                            <button
                                                key={level.index}
                                                type="button"
                                                onClick={() => setLevel(level.index)}
                                                className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] ${levelIndex === level.index ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8'}`}
                                            >
                                                <span>{level.height ? `${level.height}P` : `第 ${level.index + 1} 档`}</span>
                                                <span className="flex items-center gap-2 text-[11px] text-[#f2f2f4]/40">
                                                    {level.bitrate ? `${Math.round(level.bitrate / 1000)}kbps` : ''}
                                                    {levelIndex === level.index && <span className="text-[#56c98d]">✓</span>}
                                                </span>
                                            </button>
                                        ))}
                                    </>
                                ) : (
                                    <div className="rounded-lg bg-white/8 px-3 py-2 text-[12px] leading-5 text-[#f2f2f4]/55">
                                        这个片源只有一档清晰度。想更清楚就换线路——下面这些线路来自不同的站，画质不一样。
                                    </div>
                                )}
                                <div className="mt-1 text-[11.5px] text-[#f2f2f4]/45">换线路（换片源，也就换了画质）</div>
                                {lines.map((line, at) => (
                                    <button
                                        key={`${line.name}-${at}`}
                                        type="button"
                                        onClick={() => onLineChange(at)}
                                        className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] ${at === lineIndex ? 'bg-white/15 text-[#f2f2f4]' : 'text-[#f2f2f4]/65 hover:bg-white/8'}`}
                                    >
                                        <span className="truncate">{line.name}</span>
                                        <span className="shrink-0 text-[11px] text-[#f2f2f4]/40">{line.episodes.length} 集</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {panel === 'more' && (
                            <div className="flex flex-col gap-1">
                                {[
                                    ['倍速 0.5×', () => setSpeed(0.5)],
                                    ['倍速 1×', () => setSpeed(1)],
                                    ['倍速 1.25×', () => setSpeed(1.25)],
                                    ['倍速 1.5×', () => setSpeed(1.5)],
                                    ['倍速 2×', () => setSpeed(2)],
                                ].map(([label, run]) => (
                                    <button
                                        key={label as string}
                                        type="button"
                                        onClick={run as () => void}
                                        className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]"
                                    >
                                        {label as string}
                                    </button>
                                ))}

                                <div className="mt-2 text-[11.5px] text-[#f2f2f4]/45">画面调节</div>
                                {([
                                    ['亮度', prefs.brightness, (value: number) => patchPrefs({ brightness: value })],
                                    ['对比度', prefs.contrast, (value: number) => patchPrefs({ contrast: value })],
                                    ['饱和度', prefs.saturation, (value: number) => patchPrefs({ saturation: value })],
                                ] as Array<[string, number, (value: number) => void]>).map(([label, value, apply]) => (
                                    <label key={label} className="flex items-center gap-2 px-1 py-1 text-[11.5px] text-[#f2f2f4]/55">
                                        <span className="w-8 shrink-0">{label}</span>
                                        <input
                                            type="range"
                                            min={0.6}
                                            max={1.5}
                                            step={0.02}
                                            value={value}
                                            onChange={event => apply(Number(event.target.value))}
                                            className="h-1 min-w-0 flex-1 accent-[#56c98d]"
                                        />
                                        <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(value * 100)}%</span>
                                    </label>
                                ))}

                                <div className="mt-2 text-[11.5px] text-[#f2f2f4]/45">媒体信息</div>
                                <div className="break-all rounded-lg bg-white/5 px-2.5 py-2 text-[10.5px] leading-4 text-[#f2f2f4]/35">{mediaUrl || url}</div>
                                <button type="button" onClick={goFullscreen} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">全屏</button>
                                <button type="button" onClick={shootScreen} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">截图</button>
                                <button type="button" onClick={togglePip} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">画中画</button>
                                <button type="button" onClick={() => { void openOutsideLink(mediaUrl || url); }} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">用浏览器打开</button>
                                <button type="button" onClick={() => setHelpOpen(true)} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[#f2f2f4]/65 hover:bg-white/8 hover:text-[#f2f2f4]">快捷键一览</button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {error && (
                <div className="absolute bottom-20 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-[#e3a949]/15 px-3 py-1.5 text-[12px] text-[#e3a949]">
                    {error}
                </div>
            )}

            {failedPage && mediaUrl === '' && !resolving && (
                <span className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 text-[11px] text-[#f2f2f4]/30">页面已抓取，但没有可用的媒体地址</span>
            )}

            {/* 快捷键一览：一张玻璃卡片，照着按就行。 */}
            {helpOpen && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm" onClick={() => setHelpOpen(false)}>
                    <div
                        onClick={event => event.stopPropagation()}
                        className="flex max-h-[82vh] w-[min(92vw,620px)] flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#101014]/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl"
                    >
                        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                            <div className="text-[13px] font-medium text-[#f2f2f4]">快捷键一览</div>
                            <button type="button" onClick={() => setHelpOpen(false)} className="rounded-full p-1 text-[#f2f2f4]/70 hover:bg-white/10" aria-label="关闭">✕</button>
                        </div>
                        <div className="grid min-h-0 grid-cols-1 gap-x-6 overflow-y-auto px-4 py-3 sm:grid-cols-2">
                            {KEYMAP.map(([keys, action]) => (
                                <div key={keys} className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] py-1.5">
                                    <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-[1px] text-[11px] text-[#f2f2f4]/85">{keys}</span>
                                    <span className="min-w-0 text-right text-[11.5px] text-[#f2f2f4]/55">{action}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {menu && (
                <div
                    ref={menuRef}
                    data-video-context-menu
                    className="fixed z-[95]"
                    style={{ left: menu.x, top: menu.y }}
                    onClick={event => event.stopPropagation()}
                >
                    <div
                        className="w-[214px] overflow-y-auto rounded-xl border border-white/10 bg-[#101014]/95 py-1 shadow-2xl backdrop-blur"
                        style={{ maxHeight: 470 }}
                    >
                        {menuEntries.map((entry, at) => {
                            if (entry.kind === 'line') {
                                return <div key={`line-${at}`} aria-hidden className="mx-2 my-1 h-px bg-white/12" />;
                            }
                            const row = 'flex w-full items-center gap-1.5 px-2.5 py-[5px] text-left text-[12.5px] leading-5 text-[#f2f2f4]/85 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-30';
                            if (entry.kind === 'branch') {
                                const expanded = sub?.at === at;
                                return (
                                    <button
                                        key={entry.label}
                                        type="button"
                                        aria-haspopup="menu"
                                        aria-expanded={expanded}
                                        onMouseEnter={event => setSub({ at, top: event.currentTarget.offsetTop })}
                                        onClick={event => setSub(expanded ? null : { at, top: event.currentTarget.offsetTop })}
                                        className={`${row} ${expanded ? 'bg-white/10 text-[#f2f2f4]' : ''}`}
                                    >
                                        <span aria-hidden className="w-4 shrink-0" />
                                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                        <ChevronRight size={13} className="shrink-0 text-[#f2f2f4]/40" />
                                    </button>
                                );
                            }
                            return (
                                <button
                                    key={entry.label}
                                    type="button"
                                    disabled={entry.disabled}
                                    onMouseEnter={() => setSub(null)}
                                    onClick={() => { setMenu(null); setSub(null); entry.run(); }}
                                    className={row}
                                >
                                    <span aria-hidden className="flex w-4 shrink-0 justify-center text-[#56c98d]">
                                        {entry.checked ? <Check size={13} /> : null}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                    {entry.hint ? <span className="shrink-0 text-[11px] tabular-nums text-[#f2f2f4]/35">{entry.hint}</span> : null}
                                </button>
                            );
                        })}
                    </div>
                    {sub && menuEntries[sub.at]?.kind === 'branch' && (() => {
                        const branch = menuEntries[sub.at] as MenuBranch;
                        // 子菜单跟着那一行出现；贴到窗口底就往回收，别掉出去。
                        const limit = window.innerHeight - menu.y - 12 - (branch.children.length * 28 + 12);
                        const top = Math.max(0, Math.min(sub.top, limit));
                        return (
                            <div
                                role="menu"
                                className="absolute left-[208px] w-[196px] overflow-y-auto rounded-xl border border-white/10 bg-[#101014]/95 py-1 shadow-2xl backdrop-blur"
                                style={{ top, maxHeight: 320 }}
                            >
                                {branch.children.map(child => (
                                    <button
                                        key={child.label}
                                        type="button"
                                        disabled={child.disabled}
                                        onClick={() => { setMenu(null); setSub(null); child.run(); }}
                                        className="flex w-full items-center gap-1.5 px-2.5 py-[5px] text-left text-[12.5px] leading-5 text-[#f2f2f4]/85 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
                                    >
                                        <span aria-hidden className="flex w-4 shrink-0 justify-center text-[#56c98d]">
                                            {child.checked ? <Check size={13} /> : null}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">{child.label}</span>
                                        {child.hint ? <span className="shrink-0 text-[11px] tabular-nums text-[#f2f2f4]/35">{child.hint}</span> : null}
                                    </button>
                                ))}
                            </div>
                        );
                    })()}
                </div>
            )}
        </div>
    );
};

export default VideoPlayer;
