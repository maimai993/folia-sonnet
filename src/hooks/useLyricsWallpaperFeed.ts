import React from 'react';
import { isCapacitorAndroid } from '../platform/runtime';
import { clearLyricsWallpaper, publishLyricsWallpaper, setWallpaperAppearance } from '../platform/foliaWallpaper';
import { flattenTuning, tuningFieldFor, withGlobalSettings } from '../platform/wallpaperVisualizerTuning';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import { useTypographySettingsStore } from '../stores/useTypographySettingsStore';
import { useThemeSettingsStore } from '../stores/useThemeSettingsStore';
import { useMotionSettingsStore } from '../stores/useMotionSettingsStore';
import { useLyricSettingsStore } from '../stores/useLyricSettingsStore';
import { useStageSettingsStore } from '../stores/useStageSettingsStore';
import { findLatestActiveLineIndex } from '../utils/appPlaybackHelpers';
import type { Line } from '../types';

// src/hooks/useLyricsWallpaperFeed.ts
// 把歌词送到原生壁纸。
//
// 关键在于**不要指望这里的定时器**：应用退到后台后 WebView 的 JS 定时器会被系统挂起，
// 靠它推「当前行」的话，后台时歌词就永远停在一句上。所以换歌时把整条时间轴一次性交过去，
// 播放中只偶尔推一个时间锚点；之后由原生按墙钟自己往前推，JS 停了歌词也照样往下走。

const DEFAULT_ACCENT = '#7c5cff';
// 壁纸拿封面做两件事：模糊底图，以及**给歌词的高亮取色**。取色需要真实的画面，
// 256 太小（缩到那个尺寸后颜色已经被插值抹平了），768 才够还原封面的主色分布。
const COVER_EDGE = 768;
/** 心跳间隔。前台时用来校正锚点；后台被挂起也无所谓，原生自己会走。 */
const TICK_MS = 500;
/**
 * 判定「跳转」的阈值。正常播放 500ms 只走 500ms，两次采样之间差出 2 秒
 * 就只可能是拖动进度条或跳到别的歌 —— 这时才把锚点同步过去。
 */
const SEEK_JUMP_MS = 2000;
/**
 * 漂移容差（毫秒）。
 *
 * 原生那边的位置是「锚点 + 墙钟」自己推出来的，和应用的实际位置差个几十到几百毫秒
 * 完全看不出来。换行时只有差出这么多才值得把锚点重设一次 —— 重设本身会让叠层的
 * 歌词/动效跳一下，段界上跳一下就是用户说的抽搐。
 * 给得比 `getCurrentTime()` 的更新粒度宽一档，免得把采样噪声当成漂移。
 */
const WALLPAPER_DRIFT_TOLERANCE_MS = 900;

/** 超过这个长度的字符串值不进签名：那是 base64 图片（.key 本身还是进的）。 */
const MAX_FINGERPRINT_STRING = 512;

/** 32 位字符串散列（FNV-1a 变体）：只要内容变了，值几乎必然变。 */
const hashString = (value: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
};

/** 把一个 store 的**数据**部分（不含 action 函数）折成一个稳定的字符串。 */
const fingerprintState = (state: Record<string, unknown>): string => {
    const parts: string[] = [];
    for (const key of Object.keys(state).sort()) {
        const value = state[key];
        if (typeof value === 'function') continue;
        if (typeof value === 'string' && value.length > MAX_FINGERPRINT_STRING) {
            // 图本体太大，拿长度当代表：换图（哪怕只是一张）仍然会改变签名。
            parts.push(`${key}:len${value.length}`);
            continue;
        }
        parts.push(`${key}:${JSON.stringify(value) ?? 'null'}`);
    }
    return parts.join('|');
};

/**
 * 「会改变叠层观感的那几个 store 变了」的信号，值是那三个 store 数据体的散列。
 *
 * 为什么需要它：叠层页面是**另一个 WebView** 里的一份全新 store ——
 * 它只在加载那一刻读过一次 localStorage，之后和主 WebView 再无联系。
 * 「歌词动画实验台」里改任意一个参数（各模式的 tuning、排版、静态模式），
 * 主侧立刻生效，叠层却永远停在旧值上 —— 就是用户报的「改了没反应」。
 *
 * 这里不去逐个列举那些 key（一百多项，加一项就漏一项），
 * 而是把三个 store 的**整个数据体**折成签名：任何一项变了散列就变。
 * 这个散列经 `wp.settingsStamp` 进 `wp.` 那张表，原生那边存的那张散列表跟着变，
 * `reloadOnTuningChange` 就会重载一份新页面 —— 新页面重新读存储，改动到位。
 *
 * 用 subscribe 而不是「订阅整个 store 让它重渲染」：只有散列真的变了才 setState，
 * 播放期间被反复写入同一个值时不会产生任何副作用。
 */
const useAppearanceSettingsStamp = (): number => {
    /*
     * 参与签名的 store 必须**一次列全**。
     *
     * 叠层那份页面是另一个 WebView 里的全新 store，只在加载那一刻读一次 localStorage；
     * 之后它能不能看到新值，全靠这个签名变了 → 原生重载一份页面。
     * 漏掉一个 store，那个 store 里的设置在叠层上就**永远不生效**，
     * 而主界面（同一个上下文）永远是好的 —— 症状就是"改了没反应、但又是随机的"。
     * 这条链已经因为这个漏过四次（每次都是不同的设置项），
     * 所以宁可多列几个（多一次重载的代价远小于再漏一次）。
     */
    const snapshotStates = () => ({
        visualizer: useVisualizerSettingsStore.getState() as unknown as Record<string, unknown>,
        typography: useTypographySettingsStore.getState() as unknown as Record<string, unknown>,
        theme: useThemeSettingsStore.getState() as unknown as Record<string, unknown>,
        motion: useMotionSettingsStore.getState() as unknown as Record<string, unknown>,
        lyric: useLyricSettingsStore.getState() as unknown as Record<string, unknown>,
        stage: useStageSettingsStore.getState() as unknown as Record<string, unknown>,
    });
    const [stamp, setStamp] = React.useState(() => hashString(fingerprintState(snapshotStates())));
    React.useEffect(() => {
        const compute = () => hashString(fingerprintState(snapshotStates()));
        let current = compute();
        // 首帧就对齐一次：useState 的初值是在上一次 render 时算的，这中间改过就过期了。
        setStamp(previous => (previous === current ? previous : current));
        /*
         * 去抖之后才算。
         *
         * 签名是拿整整三个 store 的数据体去序列化的（百来个字段、几十 KB 字符串）。
         * 而 zustand 的 subscribe 是**每次 setState 都回调** —— 实验台里拖一根滑杆会连着
         * 触发几十次，那条路径上一步也不能慢。去抖 250ms 之后，整个标定过程只在
         * 手停下来之后跑一次。
         */
        let timer = 0;
        const check = () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = 0;
                const next = compute();
                if (next === current) return;
                current = next;
                setStamp(next);
            }, 250);
        };
        const unsubscribers = [
            useVisualizerSettingsStore.subscribe(check),
            useTypographySettingsStore.subscribe(check),
            useThemeSettingsStore.subscribe(check),
            useMotionSettingsStore.subscribe(check),
            useLyricSettingsStore.subscribe(check),
            useStageSettingsStore.subscribe(check),
        ];
        return () => {
            if (timer) window.clearTimeout(timer);
            unsubscribers.forEach(unsubscribe => unsubscribe());
        };
    }, []);
    return stamp;
};

type UseLyricsWallpaperFeedOptions = {
    lyrics: { lines: Line[] } | null;
    /** 读当前播放时间（秒）。传 get 方法而不是值，避免每次渲染重建定时器。 */
    getCurrentTime: () => number;
    title: string | null;
    artist: string | null;
    coverUrl: string | null;
    playerState: string;
    /** 整首歌时长（秒）。壁纸顶部的进度条要用；拿不到就传 0，那条不画。 */
    duration?: number;
    /** App 当前主题，用来让壁纸与 App 用同一套配色和动效强度。 */
    accentColor?: string | null;
    backgroundColor?: string | null;
    /** 主文本色 / 次色。叠层那份页面拿不到 App 的主题对象，只能靠这里下发。 */
    primaryColor?: string | null;
    secondaryColor?: string | null;
    animationIntensity?: 'calm' | 'normal' | 'chaotic' | null;
};

const MOTION_BY_INTENSITY: Record<string, number> = {
    calm: 0.6,
    normal: 1,
    chaotic: 1.5,
};

/** 把封面压成小图 base64：壁纸只用作模糊底图，不需要原图。 */
const loadCoverAsBase64 = async (url: string): Promise<string | null> => {
    if (typeof document === 'undefined') return null;
    try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (typeof createImageBitmap !== 'function') return null;
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, COVER_EDGE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
        return null;
    }
};

export const useLyricsWallpaperFeed = ({
    lyrics,
    getCurrentTime,
    title,
    artist,
    coverUrl,
    playerState,
    duration,
    accentColor,
    backgroundColor,
    primaryColor,
    secondaryColor,
    animationIntensity,
}: UseLyricsWallpaperFeedOptions): void => {
    const enabled = isCapacitorAndroid();
    const feedEnabled = useVisualizerSettingsStore(state => state.lyricsWallpaperFeed);
    const backgroundMode = useVisualizerSettingsStore(state => state.lyricsWallpaperBackground);
    const backgroundImage = useVisualizerSettingsStore(state => state.lyricsWallpaperImage);
    const backgroundBlur = useVisualizerSettingsStore(state => state.lyricsWallpaperBlur);
    const showProgress = useVisualizerSettingsStore(state => state.lyricsWallpaperProgress);
    const showTranslation = useVisualizerSettingsStore(state => state.lyricsWallpaperTranslation);
    // 壁纸动画风格跟随 App 选中的可视化模式。
    const visualizerMode = useVisualizerSettingsStore(state => state.visualizerMode);
    const wallpaperStyle = useVisualizerSettingsStore(state => state.lyricsWallpaperStyle);
    // 壁纸样式：精简 = 固定一套安静的原生风格；跟随 = 用上面的可视化模式。
    // 必须排在 visualizerMode 之后 —— 同一个 const 链里提前引用会撞 TDZ，启动时直接崩。
    const wallpaperVisualizer = wallpaperStyle === 'minimal' ? 'minimal' : visualizerMode;
    // 实验台里当前模式那份配置。取原始引用交给 useMemo 摊平，
    // 直接在 selector 里摊平会让 zustand 每次都拿到新对象而无限重渲染。
    const tuningField = tuningFieldFor(wallpaperVisualizer);
    const rawTuning = useVisualizerSettingsStore(
        tuningField ? (state: Record<string, unknown>) => state[tuningField] : () => null);
    // 背景那几个全局开关也一起跟随（不透明度 / 暗角 / 几何背景）。
    const backgroundOpacity = useVisualizerSettingsStore(state => state.backgroundOpacity);
    const wallpaperOverlayOpacity = useVisualizerSettingsStore(state => state.wallpaperOverlayOpacity);
    const wallpaperOverlayEnabled = useVisualizerSettingsStore(state => state.wallpaperOverlayEnabled);
    const wallpaperOverlayLockScreen = useVisualizerSettingsStore(state => state.wallpaperOverlayLockScreen);
    const wallpaperOverlayLockScreenOnly = useVisualizerSettingsStore(
        state => state.wallpaperOverlayLockScreenOnly);
    const wallpaperOverlayAllApps = useVisualizerSettingsStore(state => state.wallpaperOverlayAllApps);
    const wallpaperOverlayHideNativeLyrics = useVisualizerSettingsStore(
        state => state.wallpaperOverlayHideNativeLyrics);
    const wallpaperOverlayHideNativeProgress = useVisualizerSettingsStore(
        state => state.wallpaperOverlayHideNativeProgress);
    const wallpaperOverlaySkipInstrumental = useVisualizerSettingsStore(
        state => state.wallpaperOverlaySkipInstrumental);
    const wallpaperOverlayHideWhenPaused = useVisualizerSettingsStore(
        state => state.wallpaperOverlayHideWhenPaused);
    const wallpaperOverlayHideAfterLyricsEnd = useVisualizerSettingsStore(
        state => state.wallpaperOverlayHideAfterLyricsEnd);
    const disableVisualizerVignette = useVisualizerSettingsStore(state => state.disableVisualizerVignette);
    const disableVisualizerGeometricBackground = useVisualizerSettingsStore(
        state => state.disableVisualizerGeometricBackground);
    // 外观 store 的签名：变了就让叠层那份页面重载，见 useAppearanceSettingsStamp。
    const settingsStamp = useAppearanceSettingsStamp();
    const tuning = React.useMemo(
        () => withGlobalSettings(flattenTuning(rawTuning), {
            backgroundOpacity,
            disableVisualizerVignette,
            disableVisualizerGeometricBackground,
            wallpaperOverlayOpacity,
            wallpaperOverlayEnabled,
            wallpaperOverlayLockScreen,
            wallpaperOverlayLockScreenOnly,
            wallpaperOverlayAllApps,
            wallpaperOverlayHideNativeLyrics,
            wallpaperOverlayHideNativeProgress,
            wallpaperOverlaySkipInstrumental,
            wallpaperOverlayHideWhenPaused,
            wallpaperOverlayHideAfterLyricsEnd,
            settingsStamp,
        }),
        [rawTuning, backgroundOpacity, disableVisualizerVignette,
            disableVisualizerGeometricBackground, wallpaperOverlayOpacity, wallpaperOverlayEnabled,
            wallpaperOverlayLockScreen, wallpaperOverlayLockScreenOnly, wallpaperOverlayAllApps,
            wallpaperOverlayHideNativeLyrics, wallpaperOverlayHideNativeProgress,
            wallpaperOverlaySkipInstrumental, wallpaperOverlayHideWhenPaused,
            wallpaperOverlayHideAfterLyricsEnd, settingsStamp]);
    const active = enabled && feedEnabled;
    const durationMs = Math.max(0, Math.round((duration ?? 0) * 1000));

    const playing = playerState === 'PLAYING';
    const latest = React.useRef({ playing });
    latest.current.playing = playing;

    // 封面用 state 而不是 ref：它是异步抓的，换歌时那一刻多半还没到。用 ref 的话
    // 第一次 publish 带着 null 封面就过去了，而 ref 变化不会触发重渲染，
    // 于是封面（以及从封面取的高亮色）永远推不到壁纸那边 —— 表现就是「歌词始终纯白」。
    const [wallpaperCover, setWallpaperCover] = React.useState<string | null>(null);

    // 关掉开关时清一次，别让壁纸停在过期的那一行上。
    React.useEffect(() => {
        if (enabled && !feedEnabled) {
            void clearLyricsWallpaper();
        }
    }, [enabled, feedEnabled]);

    // 封面只在换歌时抓一次。
    React.useEffect(() => {
        if (!enabled) return;
        setWallpaperCover(null);
        if (!coverUrl) return;
        let cancelled = false;
        void loadCoverAsBase64(coverUrl).then((value) => {
            if (!cancelled && value) {
                setWallpaperCover(value);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [enabled, coverUrl]);

    // 外观（背景模式 / 自选图 / 模糊强度 / 进度条 / 可视化风格）单独下发，不牵动时间轴。
    React.useEffect(() => {
        if (!enabled) return;
        void setWallpaperAppearance({
            background: backgroundMode,
            image: backgroundImage,
            visualizer: wallpaperVisualizer,
            blur: backgroundBlur,
            progress: showProgress,
            translation: showTranslation,
            tuning,
            durationMs,
        });
    }, [enabled, backgroundMode, backgroundImage, wallpaperVisualizer, backgroundBlur, showProgress,
        showTranslation, tuning, durationMs]);

    // 换歌（或歌词本身变了）时下发整条时间轴。
    React.useEffect(() => {
        if (!active) return;
        const lines = lyrics?.lines ?? [];
        void publishLyricsWallpaper({
            title: title ?? '',
            artist: artist ?? '',
            accent: accentColor || DEFAULT_ACCENT,
            backgroundColor: backgroundColor || '#09090b',
            primaryColor: primaryColor || undefined,
            secondaryColor: secondaryColor || undefined,
            motion: MOTION_BY_INTENSITY[animationIntensity ?? 'normal'] ?? 1,
            cover: wallpaperCover,
            background: backgroundMode,
            image: backgroundImage,
            visualizer: wallpaperVisualizer,
            blur: backgroundBlur,
            progress: showProgress,
            translation: showTranslation,
            tuning,
            durationMs,
            timeline: lines.map((line) => {
                const entry: { text: string; start: number; end: number; translation?: string } = {
                    text: line.fullText,
                    start: Math.round(line.startTime * 1000),
                    end: Math.round(line.endTime * 1000),
                };
                // 翻译整段不给：原生那边 null 就是「没翻译」，不会为了对齐而画一条空行。
                const translation = line.translation?.trim();
                if (translation) {
                    entry.translation = translation;
                }
                return entry;
            }),
            positionMs: Math.round(getCurrentTime() * 1000),
            playing,
        });
        // getCurrentTime 是稳定的取数函数，不参与依赖比较以外的重算。
        // wallpaperCover 在依赖里：封面异步到位后再推一次，壁纸才能拿到它和从它取的高亮色。
    }, [active, lyrics, title, artist, backgroundMode, backgroundImage, wallpaperVisualizer,
        accentColor, backgroundColor, primaryColor, secondaryColor, animationIntensity, backgroundBlur,
        showProgress, showTranslation, tuning, durationMs, wallpaperCover]);

    // 播放/暂停要立刻通知，否则暂停后原生还在按墙钟往前走。
    React.useEffect(() => {
        if (!active) return;
        void publishLyricsWallpaper({
            positionMs: Math.round(getCurrentTime() * 1000),
            playing,
        });
    }, [active, playing]);

    // 换行**只在真的跑偏了的时候**才校正锚点。
    //
    // 只靠「锚点 + 自己走」的话，两边的时钟会缓慢分叉；分叉累积到一定程度，
    // 壁纸就会跑到歌词时间轴尽头之外 —— 表现就是「放着放着歌词不更新了、像提前结束」。
    //
    // 但"每次换行都校正"同样是抽搐的来源：原生那边按自己的墙钟外推得很好，
    // 每次换行都把锚点重设成应用的实际位置，叠层的歌词和动效就会在每个段界上
    // 被往回拽一下 —— 段界恰恰是眼睛盯着的地方。
    //
    // 所以这里改成**先量漂移**：差得不多（原生算得准）就一句话都不说，
    // 只有真跑偏了（卡顿、缓冲、后台限流）才在换行的瞬间对齐一次。
    React.useEffect(() => {
        if (!active) return;
        const lineList = lyrics?.lines ?? [];
        if (lineList.length === 0) return;
        let lastIndex = -1;
        // 上次推过去的锚点，以及"推的时候"这边是几点 —— 原生现在的推算值就是
        // `锚点 + 走过的墙钟`，拿它跟应用的实际位置一比就是漂移量。
        let anchorMs = -1;
        let anchorAt = 0;
        const timer = window.setInterval(() => {
            // 自己算当前行：store 里的 currentLineIndex 在主播放链路里不一定被更新，
            // 靠它做校正等于指望一个可能永远不变的值（状态栏那边就是这么踩空的）。
            const index = findLatestActiveLineIndex(lineList, getCurrentTime());
            if (index < 0 || index === lastIndex) return;
            lastIndex = index;
            const actualMs = getCurrentTime() * 1000;
            const drift = anchorMs < 0
                ? Number.POSITIVE_INFINITY
                : Math.abs(actualMs - (anchorMs + (performance.now() - anchorAt)));
            if (drift < WALLPAPER_DRIFT_TOLERANCE_MS) return;
            anchorMs = actualMs;
            anchorAt = performance.now();
            void publishLyricsWallpaper({
                positionMs: Math.round(actualMs),
                playing: latest.current.playing,
            });
        }, 250);
        return () => window.clearInterval(timer);
    }, [active, lyrics, getCurrentTime]);

    // 只在「真的发生了跳变」时同步锚点，不再定期校正。
    //
    // 原来这里是每 TICK_MS 推一次当前位置。问题是每推一次，壁纸侧的锚点就被重设一次；
    // 应用和壁纸各自的墙钟有几个毫秒的差，于是进度每隔 500ms 被往回拉一下、
    // 又被自己的时钟推出去 —— 表现出来就是歌词和动效在轻轻抽搐。
    // 壁纸侧本来就是「锚点 + 自己走」的模型，不需要这种持续校正。
    //
    // 现在只认三种事件：拖动进度条 / 跳到下一首（大跳变）、切歌（上面那个 publish）、
    // 播放暂停（上面那个 effect）。正常播放期间一次都不推。
    React.useEffect(() => {
        if (!active) return;
        let previousPosition = getCurrentTime() * 1000;
        const timer = window.setInterval(() => {
            const current = getCurrentTime() * 1000;
            const jump = Math.abs(current - previousPosition);
            previousPosition = current;
            // 正常播放一个 TICK_MS 只走 TICK_MS；超过这个量级就只可能是跳转。
            if (jump >= SEEK_JUMP_MS) {
                void publishLyricsWallpaper({
                    positionMs: Math.round(current),
                    playing: latest.current.playing,
                });
            }
        }, TICK_MS);
        return () => window.clearInterval(timer);
    }, [active]);
};
