import React from 'react';
import { isCapacitorAndroid } from '../platform/runtime';
import { clearLyricsWallpaper, publishLyricsWallpaper, pushLyricsFontToNative, setWallpaperAppearance, setWallpaperFloatingPreview, wallpaperHeartbeat, type FoliaWallpaperTimelineEntry } from '../platform/foliaWallpaper';
import { getStoredUploadedLyricsFont } from '../services/customLyricsFont';
import { flattenTuning, tuningFieldFor, withGlobalSettings } from '../platform/wallpaperVisualizerTuning';
import { useVisualizerSettingsStore, type VisualizerSettingsState } from '../stores/useVisualizerSettingsStore';
import { useTypographySettingsStore } from '../stores/useTypographySettingsStore';
import { useThemeSettingsStore } from '../stores/useThemeSettingsStore';
import { useMotionSettingsStore } from '../stores/useMotionSettingsStore';
import { useLyricSettingsStore } from '../stores/useLyricSettingsStore';
import { useStageSettingsStore } from '../stores/useStageSettingsStore';
import { findLatestActiveLineIndex } from '../utils/appPlaybackHelpers';
import { fetchCoverBytes } from '../services/coverBytes';
import { actuallyPlaying } from '../stores/motionSignals';
import { nativePlaybackEngine } from '../services/playbackEngine/nativePlaybackEngine';
import type { Line, Theme } from '../types';

// src/hooks/useLyricsWallpaperFeed.ts
// 把歌词送到原生壁纸。
//
// 关键在于**不要指望这里的定时器**：应用退到后台后 WebView 的 JS 定时器会被系统挂起，
// 靠它推「当前行」的话，后台时歌词就永远停在一句上。所以换歌时把整条时间轴一次性交过去，
// 播放中只偶尔推一个时间锚点；之后由原生按墙钟自己往前推，JS 停了歌词也照样往下走。

const DEFAULT_ACCENT = '#7c5cff';
/**
 * 托管给原生的字体大小上限。
 *
 * 几 MB 的中文字体转 base64 过一趟桥已经不便宜了（还要多占 1/3），
 * 再大就该让用户换个字体文件，而不是在这里把桥堵死。
 */
const MAX_PUSHED_FONT_BYTES = 24 * 1024 * 1024;

/**
 * 原生能不能读这个字体文件。
 *
 * Android 的 `Typeface.createFromFile` 只认 TTF / OTF，
 * **woff / woff2 读不了** —— 那种只能回落系统字体，
 * 硬推下去的结果是被原生当成坏文件删掉（校验不通过）。
 */
const isNativeLoadableFont = (mimeType: string, name: string): boolean => {
    const lowerName = (name ?? '').toLowerCase();
    const lowerMime = (mimeType ?? '').toLowerCase();
    return lowerName.endsWith('.ttf') || lowerName.endsWith('.otf')
        || lowerMime.includes('font-sfnt') || lowerMime.includes('x-font-ttf')
        || lowerMime.includes('x-font-otf') || lowerMime.includes('font/ttf')
        || lowerMime.includes('font/otf') || lowerMime.includes('ms-opentype');
};

const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        // 原生那边按「可能有 data: 前缀」解，统一去掉更省心。
        resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
});
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
/**
 * 预览的续约间隔。原生那边的租约是 45 秒，这里每 15 秒续一次。
 *
 * 「开」这个状态必须能**自己关掉**，所以不能只在挂载时报一次就完事：
 * 应用被杀、崩在设置页里、WebView 被回收 —— 「关掉预览」那一次调用一次都发不出来。
 * 只剩租约过期这一条路能收摊，所以开着的时候要一直续。
 * 间隔留了三倍余量：后台节流漏掉一两次也不会把预览搞没。
 */
const PREVIEW_RENEW_MS = 15_000;

/**
 * 心跳间隔。前台每两秒敲一下「播放管线还活着」；退到后台 JS 定时器被挂起后由
 * 播放服务接管（原生 2 秒一敲）。原生侧的超时是 8 秒，容得下几次没接着。
 */
const HEARTBEAT_MS = 2_000;

/*
 * 换歌那一推要「等一等」再发。
 *
 * 切歌为什么会闪两下：这一推是**分几次**到的 —— 先推整条时间轴（那一刻封面还没抓到、
 * 主题还是上一首的），封面抓到了再推一次，AI 主题落定了再推一次。叠层每收到一次就
 * 重画一次，于是换一首歌闪两三下。所以换歌这一推按住，等这首歌该有的东西都到齐了
 * 再一次推到位。
 *
 * 按住的三件事：主题还在途、**封面还没到**、以及最短那一拍还没走完 —— 自动生成在换歌后
 * 还隔着 650ms 那一拍才发起，不等过这一拍的话，它一起动就又是一次推送、又是一闪。
 */
/** 最短也要等这一拍（比自动生成的 650ms 多给一点，让它先发起）。 */
const THEME_SETTLE_MIN_MS = 700;
/**
 * 绝不为等主题把歌词拖住更久。
 *
 * 生成可能失败、也可能压根没开「跟着歌换主题」，那一刻叠层会一直挂着上一首的歌词 ——
 * 与其让用户盯着旧歌词，不如照推（代价是这一首还会再闪一次，但只有一次）。
 */
const THEME_SETTLE_MAX_MS = 2000;

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
    /**
     * App 当前整份主题。叠层是另一个 WebView，读不到 App 的主题对象，
     * 而 AI 主题里「有辨识度」的往往不是颜色而是 `wordColors` / `lyricsIcons`
     * 这类字段 —— 整份序列化推过去，叠层拿它打底。
     */
    theme?: Theme | null;
    /**
     * App 里这首歌的 AI 主题还没落定（正在翻本机改过的那版 / 拉云端 / 问模型）。
     *
     * 为真时换歌那一推先按住（只按到 THEME_SETTLE_MAX_MS），等主题定下来再一次推 ——
     * 不然就是「先推旧的、再推 AI 主题」，叠层跟着闪两下。
     */
    themePending?: boolean;
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
        const blob = await fetchCoverBytes(url);
        if (!blob) return null;
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
    theme,
    themePending,
    animationIntensity,
}: UseLyricsWallpaperFeedOptions): void => {
    const enabled = isCapacitorAndroid();
    /*
     * 整份主题序列化一份推给叠层。
     *
     * `theme` 是 useThemeController 里的 state，引用稳定，所以这个 memo 只在真的换主题
     * 时才重算 —— 否则下面的推送 effect 会每次渲染都重跑一遍。
     */
    const themeJson = React.useMemo(() => {
        if (!theme) return null;
        try {
            return JSON.stringify(theme);
        } catch {
            return null;
        }
    }, [theme]);
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
    // tuning 表的字段名是运行期算出来的，state 上没有对应的索引签名，
    // 所以这里过一次 unknown 再取值（不改动 store 的类型定义）。
    const rawTuning = useVisualizerSettingsStore(
        tuningField
            ? (state: VisualizerSettingsState) => (state as unknown as Record<string, unknown>)[tuningField]
            : () => null);
    // 背景那几个全局开关也一起跟随（不透明度 / 暗角 / 几何背景）。
    const backgroundOpacity = useVisualizerSettingsStore(state => state.backgroundOpacity);
    const wallpaperOverlayOpacity = useVisualizerSettingsStore(state => state.wallpaperOverlayOpacity);
    // 「精简」样式那颗悬浮歌词小窗的底色浓度。跟着同一张 tuning 表下发。
    const wallpaperFloatingOpacity = useVisualizerSettingsStore(state => state.wallpaperFloatingOpacity);
    // 小窗叠在安全区上 + 叠加模式下的左右位置。同样走 tuning 表下发。
    const wallpaperFloatingOverSafeArea = useVisualizerSettingsStore(
        state => state.wallpaperFloatingOverSafeArea);
    const wallpaperFloatingOffsetX = useVisualizerSettingsStore(
        state => state.wallpaperFloatingOffsetX);
    const wallpaperFloatingWidth = useVisualizerSettingsStore(
        state => state.wallpaperFloatingWidth);
    // 占满整条安全区 + 避开区域（宽度 / 左右位置）。
    const wallpaperFloatingFillSafeArea = useVisualizerSettingsStore(
        state => state.wallpaperFloatingFillSafeArea);
    const wallpaperFloatingAvoidWidth = useVisualizerSettingsStore(
        state => state.wallpaperFloatingAvoidWidth);
    const wallpaperFloatingAvoidOffsetX = useVisualizerSettingsStore(
        state => state.wallpaperFloatingAvoidOffsetX);
    // 设置页正开着：即使在 App 里也要把那层小窗挂出来，否则在设置页看不见预览。
    const wallpaperFloatingPreview = useVisualizerSettingsStore(
        state => state.wallpaperFloatingPreview);
    // 歌词字体的来路：跟随播放页 / 单独指定。
    const wallpaperLyricsFontMode = useVisualizerSettingsStore(
        state => state.wallpaperLyricsFontMode);
    // 「跟随」模式下要托管给原生的那个字体（播放页正在用的自定义歌词字体）。
    const lyricsCustomFont = useTypographySettingsStore(state => state.lyricsCustomFont);
    const wallpaperFloatingFontSizeMode = useVisualizerSettingsStore(
        state => state.wallpaperFloatingFontSizeMode);
    const wallpaperFloatingFontSize = useVisualizerSettingsStore(
        state => state.wallpaperFloatingFontSize);
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
            wallpaperFloatingOpacity,
            wallpaperFloatingOverSafeArea,
            wallpaperFloatingOffsetX,
            wallpaperFloatingWidth,
            wallpaperFloatingFillSafeArea,
            wallpaperFloatingAvoidWidth,
            wallpaperFloatingAvoidOffsetX,
            wallpaperLyricsFontMode,
            wallpaperFloatingFontSizeMode,
            wallpaperFloatingFontSize,
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
            disableVisualizerGeometricBackground, wallpaperOverlayOpacity, wallpaperFloatingOpacity,
            wallpaperFloatingOverSafeArea, wallpaperFloatingOffsetX, wallpaperFloatingWidth,
            wallpaperFloatingFillSafeArea, wallpaperFloatingAvoidWidth,
            wallpaperFloatingAvoidOffsetX, wallpaperLyricsFontMode,
            wallpaperFloatingFontSizeMode, wallpaperFloatingFontSize,
            wallpaperOverlayEnabled,
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

    /*
     * 回到前台 / 页面重新可见：**先把位置对齐到原生，再推**。
     *
     * 退到后台之后 WebView 的 JS 定时器被系统挂起，`getCurrentTime()` 停在挂起那一刻；
     * 而原生那边这段时间一直在放。回到前台时如果照旧拿这个旧值去推整条时间轴
     * （换歌 / 歌词变化的那个 effect 恰好会在挂起期间累积的所有变更上重跑一次），
     * 就会把**过期位置**写进锚点 —— 壁纸和叠层立刻从正确的那一句跳回几十秒前，
     * 也就是用户报的「打开前台后错误的歌词会覆盖后台的」。
     *
     * 判据用 visibilitychange + resume 两个事件：前者是切前后台，后者是 Capacitor
     * 自己补的（有些 ROM 上只来一个）。只对齐位置，不在这里推送 —— 推送交给下面
     * 那几个按内容变化触发的 effect，它们会在这一拍之后拿到已经对齐的值。
     */
    React.useEffect(() => {
        if (!active) return undefined;
        const resync = () => {
            /*
             * 原生在抽头（桥活着且手上真有歌）时，位置以它为准：
             * 引擎内部是「锚点 + 墙钟」，getPositionSec() 回来的就是原生此刻的位置。
             * 原生没在播（走 <audio> / 已释放）时什么都不同步，用的是 Web 自己的时钟。
             */
            if (!nativePlaybackEngine.isPlaying()) return;
            const nativeSec = nativePlaybackEngine.getPositionSec();
            if (!Number.isFinite(nativeSec) || nativeSec < 0) return;
            pushLyricsWallpaperPosition.current(nativeSec);
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') resync();
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('resume', resync);
        window.addEventListener('focus', resync);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('resume', resync);
            window.removeEventListener('focus', resync);
        };
    }, [active]);

    /*
     * 「把某个位置推给原生」这一支单独抽出来，供上面的回前台对齐使用。
     *
     * 写成 ref 是为了不让上面那个 effect 依赖一长串值（依赖一变就重挂监听，
     * 反而更容易漏掉真正该对齐的那一次）。
     */
    const pushLyricsWallpaperPosition = React.useRef<(seconds: number) => void>(() => {});
    pushLyricsWallpaperPosition.current = (seconds: number) => {
        void publishLyricsWallpaper({
            positionMs: Math.round(seconds * 1000),
            playing: latest.current.playing,
        });
    };

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

    /*
     * 换歌那一推的闸：记着「现在这首歌是从什么时候开始等的」。
     *
     * key 变了就是另一首歌，重新计时；同一首歌内歌词晚到、改设置这些不动它
     * （那些要当场生效，不该被闸按住）。规则见上面 THEME_SETTLE_* 那两行注释。
     */
    const songGateRef = React.useRef({ key: '', since: 0 });

    // 换歌（或歌词本身变了）时下发整条时间轴。
    React.useEffect(() => {
        if (!active) return;
        const lines = lyrics?.lines ?? [];
        /*
         * 手上没有这首歌的歌词时**不要推空轴**。
         *
         * 原生兜底切歌（通知栏 / WebView 冻结期间的自动下一首）会自己向平台拉歌词、
         * 就地发布时间轴（publishNativeTrack）。Web 这边认领后若歌词还没拉回来
         * （在线歌词一趟网络往返，慢平台好几秒），照推的话带出去的是空表 ——
         * 原生刚发对的那份就被清掉了，用户看到的就是「有概率切歌后壁纸没歌词」。
         * 空着不推：原生那边的保持原状语义（lines=null 不动时间轴）继续生效，
         * 等歌词真的到了（lines 变了）这一 effect 自然会再跑一次补上。
         */
        if (lines.length === 0 && (title ?? '').length > 0) return;
        const send = () => {
            void publishLyricsWallpaper({
                title: title ?? '',
                artist: artist ?? '',
                accent: accentColor || DEFAULT_ACCENT,
                backgroundColor: backgroundColor || '#09090b',
                primaryColor: primaryColor || undefined,
                secondaryColor: secondaryColor || undefined,
                themeJson: themeJson || undefined,
                motion: MOTION_BY_INTENSITY[animationIntensity ?? 'normal'] ?? 1,
                cover: wallpaperCover,
                /*
                 * 封面地址一起下发。
                 *
                 * base64 那份是 App 抓图转出来的，转不成（跨域 / 还没解码好）时原生就不更新，
                 * 叠层会一直挂着上一首的封面 —— 地址短、每首必变，叠层可以直接拿它去加载。
                 */
                coverUrl: coverUrl || null,
                background: backgroundMode,
                image: backgroundImage,
                visualizer: wallpaperVisualizer,
                blur: backgroundBlur,
                progress: showProgress,
                translation: showTranslation,
                tuning,
                durationMs,
                timeline: lines.map((line) => {
                    const entry: FoliaWallpaperTimelineEntry = {
                        text: line.fullText,
                        start: Math.round(line.startTime * 1000),
                        end: Math.round(line.endTime * 1000),
                    };
                    // 翻译整段不给：原生那边 null 就是「没翻译」，不会为了对齐而画一条空行。
                    const translation = line.translation?.trim();
                    if (translation) {
                        entry.translation = translation;
                    }
                    /*
                     * 逐字时间轴一起下发。
                     *
                     * 没有它，叠层只能把整行当成一个「词」渲染：歌词是整一段冒出来的，
                     * 而 AI 主题的关键词着色会命中这唯一那个 token、把整行都染成高亮色
                     * —— 两处都和播放页不一样。App 这份 words 即使对普通 LRC 也是有的
                     * （解析器按字/词把行内时间均分出来的占位），播放页的逐字推进正是靠它。
                     */
                    if (line.words && line.words.length > 1) {
                        entry.words = line.words.map(word => ({
                            text: word.text,
                            start: Math.max(entry.start, Math.round(word.startTime * 1000)),
                            end: Math.max(entry.start, Math.round(word.endTime * 1000)),
                        }));
                    }
                    return entry;
                }),
                positionMs: Math.round(getCurrentTime() * 1000),
                playing,
            });
        };
        /*
         * 换歌这一推按住，等主题落定再一次发（原因见 THEME_SETTLE_* 那两行注释）。
         *
         * 闸只在「换了一首歌」时开：歌词晚到、改设置这些**不**重开它 ——
         * 那些本来就该当场生效，按住反而成了「改了半天没反应」。
         *
         * ⚠️ 后台**不等**：`setTimeout` 在后台会被系统节流（重的直接冻住），
         * 等主题那一拍可能一分钟后才跑，而这一分钟里多半又切了歌 —— cleanup 把定时器
         * 清掉，这一首的整条时间轴（连同 AI 主题的 wordColors）就一次都没推出去，
         * 桌面叠层一直挂着上一首的样子（用户原话：「AI 主题获取也需要走原生，
         * 不然后台没有」）。前台那 650ms 是为了少打一次推送，后台没人看着，不值得赌。
         */
        const songKey = `${title ?? ''}\u0000${artist ?? ''}`;
        if (songGateRef.current.key !== songKey) songGateRef.current = { key: songKey, since: Date.now() };
        const since = songGateRef.current.since;
        const remaining = since + THEME_SETTLE_MAX_MS - Date.now();
        const waiting = remaining > 0 && (
            themePending === true
            // 封面没到就先不发：它和主题是前后脚到的，等它一起，换成一次推送。
            || (Boolean(coverUrl) && !wallpaperCover)
            || Date.now() - since < THEME_SETTLE_MIN_MS
        );
        const pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        if (!waiting || pageHidden) {
            send();
            return;
        }
        // 到期照推：等不来主题也不能让叠层一直挂着上一首的歌词。
        const timer = window.setTimeout(send, remaining);
        return () => window.clearTimeout(timer);
        // getCurrentTime 是稳定的取数函数，不参与依赖比较以外的重算。
        // wallpaperCover 在依赖里：抓到之后（或等主题那一闸放开时）推的才是带封面的那份。
    }, [active, lyrics, title, artist, backgroundMode, backgroundImage, wallpaperVisualizer,
        accentColor, backgroundColor, primaryColor, secondaryColor, themeJson, animationIntensity,
        backgroundBlur, showProgress, showTranslation, tuning, durationMs, wallpaperCover,
        coverUrl, themePending]);

    /*
     * 「跟随播放页」：把播放页那个字体的字节托管到原生。
     *
     * 播放页的歌词字体是网页侧用 FontFace 注册的（字节存在 IndexedDB 里），
     * 原生那两层是自绘的，读不到它 —— 光标个「跟随」没有任何用，
     * 必须把字节推下去落盘，原生才画得出来。
     *
     * 只在**来路切到跟随、或播放页那个字体真的换了**时才推：一个中文字体几 MB，
     * 转 base64 过一趟桥不便宜，不能跟着每次渲染走。
     */
    React.useEffect(() => {
        if (!active || wallpaperLyricsFontMode !== 'follow') return;
        let cancelled = false;
        void (async () => {
            const stored = await getStoredUploadedLyricsFont();
            if (cancelled) return;
            const usable = stored
                // 存着的字节是不是播放页正在用的那个（换过字体的话 id 会不一样）。
                && stored.id === lyricsCustomFont?.fontId
                && isNativeLoadableFont(stored.mimeType, stored.name)
                && stored.blob.size <= MAX_PUSHED_FONT_BYTES
                ? stored
                : null;
            if (!usable) {
                // 播放页没设自定义字体、或者那个格式原生读不了 → 回落系统字体。
                await pushLyricsFontToNative(null);
                return;
            }
            const base64 = await blobToBase64(usable.blob);
            if (cancelled) return;
            await pushLyricsFontToNative(base64);
        })();
        return () => {
            cancelled = true;
        };
    }, [active, wallpaperLyricsFontMode, lyricsCustomFont]);

    /*
     * 预览：设置页还开着时，让原生那层悬浮小窗**在 App 里也显示出来**。
     *
     * 正常逻辑是「在应用里就不挂」（怕盖着自己的界面、播放页本来就有歌词），
     * 但调位置 / 大小 / 避开区域那些滑条恰恰是在 App 里做的 —— 不开预览的话，
     * 拖到底屏幕上也一点反应都没有（「看不到预览界面」）。
     *
     * 走**独立通道**而不是混在 tuning 表里下发（见 setWallpaperFloatingPreview
     * 上方那段）：那张表是落盘的，而预览是会话内的瞬时状态，落一次盘就等于
     * 「应用被杀一次就永久卡在开」—— 小窗恒挂会让壁纸不再画原生歌词，
     * 同时整层被强制不吃触摸、彻底拖不动。
     */
    React.useEffect(() => {
        if (!enabled || !wallpaperFloatingPreview) return undefined;
        void setWallpaperFloatingPreview(true);
        const timer = window.setInterval(
            () => void setWallpaperFloatingPreview(true),
            PREVIEW_RENEW_MS);
        return () => {
            window.clearInterval(timer);
            void setWallpaperFloatingPreview(false);
        };
    }, [enabled, wallpaperFloatingPreview]);

    // 播放/暂停要立刻通知，否则暂停后原生还在按墙钟往前走。
    React.useEffect(() => {
        if (!active) return;
        void publishLyricsWallpaper({
            positionMs: Math.round(getCurrentTime() * 1000),
            playing,
        });
    }, [active, playing]);

    /*
     * 心跳：只要壁纸推送开着就定期敲一下「我还活着」。
     *
     * 它与上面的锚点推送是两回事 —— 锚点只在换行 / 跳变时推，正常播放期间可能
     * 几分钟都不吭声，指望不上当心跳。而原生那边「锚点 + 墙钟」只会一直往前走，
     * 一旦写锚点的一方死透了（应用被划掉后台、WebView 销毁），没人踩刹车，
     * 歌词就照最后一首歌的时间轴一路唱到头、进度条走满 —— 心跳超时就是那脚刹车：
     * 壁纸与两层叠层收掉歌词和进度条，只留背景。暂停中也照敲：歌词冻在原地
     * 是「用户看得见的状态」，不算没人管还在走。
     *
     * 只覆盖前台；退到后台 JS 定时器被挂起，由播放服务接管（音频还在放，
     * 歌词就得继续走）。App 一死两条心跳一起停，超时后壁纸只剩背景。
     */
    React.useEffect(() => {
        if (!active) return undefined;
        const timer = window.setInterval(() => void wallpaperHeartbeat(), HEARTBEAT_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    /*
     * 「音频**真的**在不在播」一变，就立刻把锚点同步过去。
     *
     * 光看上面那个 playerState 不够 —— 状态机只记「用户 / 程序自己发起的动作」，
     * 外部打断（别的 App 抢走音频焦点，系统直接把 media 暂停）进不了状态机：
     * 状态机还停在 PLAYING，音频其实已经停了。而原生那边是「锚点 + 墙钟」自己往前推的，
     * 拿到 playing = true 就会一路把歌词推到实际位置**前面**去，而且不会自己回来
     * （用户原话：播放被其他东西打断了进度就不会更新了 —— 是推过头了，不是没推）。
     *
     * 反过来也走这一条：暂停后重新播放，锚点跟着重启。
     *
     * actuallyPlaying 是个 MotionValue，读它不会触发重渲染，所以只能自己轮询。
     * 500ms 对「开不开始外推」这件事完全够：差半秒的歌词位置看不出来，
     * 差半秒的「停没停」才要命。
     */
    React.useEffect(() => {
        if (!active) return undefined;
        let lastPushed = actuallyPlaying.get() > 0.5;
        const timer = window.setInterval(() => {
            const now = actuallyPlaying.get() > 0.5;
            if (now === lastPushed) return;
            lastPushed = now;
            void publishLyricsWallpaper({
                positionMs: Math.round(getCurrentTime() * 1000),
                playing: now,
            });
        }, TICK_MS);
        return () => window.clearInterval(timer);
    }, [active]);

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

    /*
     * 切到后台之前，把最后的状态推一次。
     *
     * 后台时 WebView 的 JS 定时器会被系统挂起 —— 上面那几个 effect 全都不再跑，
     * 于是「AI 主题（含 wordColors 的字级高亮）」和播放位置就永远停在挂起前那一刻，
     * 桌面小窗 / 壁纸上看到的是上一次的状态。`visibilitychange` 在真正挂起之前
     * 一定会触发一次，所以在这里补最后一遍。
     *
     * 用 ref 拿最新的闭包：写成 effect 的依赖会把上面那一长串全部拖进来，
     * 每改一个值就重新挂一次监听，反而更容易漏。
     */
    const flushToNative = React.useRef<() => void>(() => {});
    flushToNative.current = () => {
        void publishLyricsWallpaper({
            // 主题要带：AI 主题的字级高亮（wordColors）就在这一份里，
            // 只推四个颜色的话小窗那边一点效果都没有。
            themeJson: themeJson || undefined,
            positionMs: Math.round(getCurrentTime() * 1000),
            playing: latest.current.playing,
        });
    };
    React.useEffect(() => {
        if (!active) return;
        const flush = () => flushToNative.current();
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', flush);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('pagehide', flush);
        };
    }, [active]);
};
