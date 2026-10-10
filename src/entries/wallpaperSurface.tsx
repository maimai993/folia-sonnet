import React from 'react';
import ReactDOM from 'react-dom/client';
import { useMotionValue, type MotionValue } from 'framer-motion';

/*
 * 这个 import 不能省。
 *
 * 全局样式（Tailwind 那套工具类）本来是 src/bootstrap.tsx 引的，而壁纸页是**另一个 HTML 入口**，
 * 不经过 bootstrap —— 结果整个壁纸页没有任何工具类生效：`absolute` / `inset-0` / `w-full`
 * 全是空字符串，各模式的容器全是普通流里的 auto 高度，画布被卡在兜底下限（240），
 * 内容跑到屏幕外、被拉伸、甚至整个不显示。
 * 症状很有迷惑性（看起来像窗口尺寸问题），实际是**样式表根本没加载**。
 */
import '../index.css';

import VisualizerRenderer from '../components/visualizer/VisualizerRenderer';
import { collectVisualizerTunings } from '../components/visualizer/tuningRegistry';
import { NO_LYRIC_LINES } from '../utils/lyrics/noLyricLines';

/*
 * 把整页底色压回透明。
 *
 * 全局样式（src/index.css）里有一条 `body { background-color: #09090b; }` ——
 * 那是给 App 本体用的底色。壁纸页引了同一份样式表，这一条也跟着生效，
 * 于是整页被刷成一层深灰、把底下的壁纸全糊住（用户看到的就是"灰色遮罩"）。
 *
 * 之前没引样式表时没有这条规则，所以问题看起来像是"引入 CSS 之后才出现的"。
 * 用 !important + 放在 head 末尾，压过样式表里那条。
 */
const forceTransparentBackdrop = () => {
    const style = document.createElement('style');
    style.textContent = `
        html, body, #wallpaper-root {
            background: transparent !important;
            background-color: transparent !important;
        }
    `;
    document.head.appendChild(style);
};

forceTransparentBackdrop();
import { buildBuiltinDualTheme } from '../hooks/themeControllerState';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import { useTypographySettingsStore } from '../stores/useTypographySettingsStore';
import { useThemeSettingsStore } from '../stores/useThemeSettingsStore';
import type { AudioBands, Line, Theme, VisualizerMode } from '../types';

// src/entries/wallpaperSurface.tsx
// 动态壁纸里那层 WebView 的页面 —— 挂的就是播放页同一个 VisualizerRenderer。
//
// 为什么要有这个页面：播放页的十几个可视化是 PixiJS / three.js 场景，
// 而 WallpaperService 只能往 Surface 上画原生 GLES。想让壁纸「和播放页一模一样」，
// 唯一的办法就是让壁纸跑同一套渲染代码，而不是在 GLES 里照着参数模仿。
//
// 数据分两路：
//  - **静态设置**（模式、不透明度、字体、各模式 tuning）来自 localStorage。
//    叠层页面的 origin 和应用主 WebView 相同（都是 https://localhost），
//    所以这些直接读 store 就有，不需要从原生传一遍。
//  - **动态数据**（当前行、播放位置、播放状态、主题色）由原生每 200ms 注入一次
//    window.__foliaWallpaperPush(...)，页面按 rAF 自己往前插值。

type WallpaperTimedLine = {
    text: string;
    /** 毫秒 */
    start: number;
    /** 毫秒 */
    end: number;
    translation?: string;
};

export type WallpaperPayload = {
    positionMs: number;
    playing: boolean;
    durationMs?: number;
    title?: string;
    artist?: string;
    accent?: string;
    backgroundColor?: string;
    /** App 当前主题的主文本色。没有（旧包）时退回从高亮色派生，行为不变。 */
    primaryColor?: string;
    /** App 当前主题的次色（未唱到的那些行）。 */
    secondaryColor?: string;
    /**
     * App 当前**整份主题**。
     *
     * AI 主题真正的辨识度往往不在四个颜色上，而在 `wordColors`（给指定词上色）
     * 和 `lyricsIcons`（可视化里飘的图标）这类字段里 —— 只推颜色的话这两样一个都来不了，
     * 叠层画出来就是「配色变了，AI 主题的效果一点没有」。
     */
    theme?: Partial<Theme> | null;
    visualizer?: string;
    lines?: WallpaperTimedLine[];
    firstIndex?: number;
};

// 壁纸这边拿不到音频频谱：叠层页面不在播放会话里，没有 AnalyserNode。
// 和 OBS 浏览器源一样，能量恒为 0，可视化会走「安静」那一支。
const useSilentAudio = (): { audioPower: MotionValue<number>; audioBands: AudioBands } => {
    const audioPower = useMotionValue(0);
    const bass = useMotionValue(0);
    const lowMid = useMotionValue(0);
    const mid = useMotionValue(0);
    const vocal = useMotionValue(0);
    const treble = useMotionValue(0);
    return React.useMemo(
        () => ({ audioPower, audioBands: { bass, lowMid, mid, vocal, treble } }),
        [audioPower, bass, lowMid, mid, vocal, treble]);
};

/** 原生推下来的最后一个快照。 */
let latest: WallpaperPayload = { positionMs: 0, playing: false };
let receivedAtMs = performance.now();
/**
 * 「第一帧已经画出来了」在**页面这一级**的记住。
 *
 * 必须是模块级的，不能是组件里的 useState：切歌的那一瞬 App 会先推一份空数据
 * （歌名还没到），`hasData` 变假 → 组件返回 null → 再挂载时 state 回到 false →
 * 舞台又从 opacity 0 开始淡入一次 —— 用户看到的就是「叠层突然消失，然后又出现」。
 * 淡入只应该发生在这份页面**第一次**画出内容的时候，之后一律保持全不透明。
 */
let contentPainted = false;
const subscribers = new Set<() => void>();

declare global {
    interface Window {
        __foliaWallpaperPush?: (payload: WallpaperPayload) => void;
        /**
         * "第一帧画面已经画出来了"的信号，原生据此才开始淡入。
         *
         * 为什么需要它：可视化是懒加载的（chunk 下载 + Pixi/WebGL 初始化），
         * 从"收到数据"到"真的画出东西"中间有一段空窗。原生如果按固定延时淡入，
         * 就会淡入到一个还没画完的页面 —— 用户看到的是"闪一下黑，然后突然出现"。
         * 让它回过头来问页面准备到哪一步，才治本。
         */
        __foliaWallpaperPainted?: boolean;
        /**
         * 已经收到过多少份数据。原生推完会把它读回去当"送达回执"。
         *
         * 为什么需要回执：evaluateJavascript 在页面还在导航时会**静默丢掉**调用而不报错，
         * 原生那边看起来是成功的，于是把「推过了」记进去重签名 —— 之后状态没变就再也不推，
         * 页面永远停在空状态（表现是"切到下一首再也不出来"）。有个计数，原生才能分清
         * "真的送到了"和"我以为送到了"。
         */
        __foliaWallpaperPushCount?: number;
        /**
         * 页面手里这份数据的歌名。原生会隔几秒回来对一次：
         * 对不上就说明有推送被丢了（桥调用在页面导航期会被静默丢掉），补推一次。
         */
        __foliaWallpaperLastTitle?: string;
        /**
         * 最近一份推送的原文和时间戳，供原生核对「页面手里的状态有没有过期」。
         * 原生拿它对三样：歌名、时间轴（行数 + 首行）、两边各自外推的位置差 ——
         * 推送被签名吞掉时页面会停在「新歌名 + 旧歌词 / 旧锚点」上，
         * 光看歌名发现不了，必须连时间轴和位置一起核对。
         */
        __foliaWallpaperLatest?: WallpaperPayload;
        __foliaWallpaperReceivedAt?: number;
    }
}

/**
 * 上一份**非空**的数据，以及它是什么时候到的。
 *
 * 换歌是两步走：App 先推「新歌名 + 还没有歌词」（歌词是异步解析的），
 * 隔几百毫秒再推一次带时间轴的。那一段空档里页面如果照着"没有数据"处理，
 * 内容会先消失、再重新出现 —— 就是用户说的「叠层突然消失然后出现」。
 *
 * 所以空档里沿用上一份（**只在 3 秒之内**）：超过这个时长说明这首歌真的没歌词
 * （纯音乐），那时候该走占位/收起的路径，不能一直挂着上一首的歌词。
 */
let lastGoodLines: WallpaperTimedLine[] | null = null;
let lastGoodTitle = '';
let lastGoodAt = 0;
const STALE_FALLBACK_MS = 3000;

window.__foliaWallpaperPush = (incoming) => {
    let payload = incoming;
    if (!payload || typeof payload !== 'object') return;
    const now = performance.now();
    if ((payload.lines?.length ?? 0) > 0) {
        lastGoodLines = payload.lines ?? null;
        if (payload.title) lastGoodTitle = payload.title;
        lastGoodAt = now;
    } else if (now - lastGoodAt < STALE_FALLBACK_MS && (lastGoodLines || lastGoodTitle)) {
        // 空档：补上上一份内容，画面不做任何变化。
        payload = {
            ...payload,
            title: payload.title || lastGoodTitle,
            lines: lastGoodLines ?? payload.lines,
        };
    }
    latest = payload;
    receivedAtMs = performance.now();
    window.__foliaWallpaperPushCount = (window.__foliaWallpaperPushCount ?? 0) + 1;
    window.__foliaWallpaperLastTitle = payload.title ?? '';
    window.__foliaWallpaperLatest = payload;
    window.__foliaWallpaperReceivedAt = receivedAtMs;
    subscribers.forEach(notify => notify());
};

const positionMsNow = (): number => {
    if (!latest.playing) return latest.positionMs;
    return latest.positionMs + (performance.now() - receivedAtMs);
};

const msToSec = (value: number): number => value / 1000;

/**
 * 画布 / 挂载内容出现之后还要**稳定存在多久**才算「真的画好了」。
 *
 * 只判"有没有画布"是不够的：可视化是懒加载的，画布一出现我们就放行，
 * 这些模式还要再拉资源 / 编译着色器 / 铺第一帧内容 —— 那一段里晚到的东西
 * （尤其是会动的那一层：动态背景、粒子、逐字流光）恰好落在窗口已经全不透明的时候，
 * 用户看到的就是「歌词淡入正常，动态效果突然出现」。这 400ms 是为了吃掉那段空窗。
 */
const CONTENT_DWELL_MS = 400;

/**
 * 把原生推来的那几行转成渲染器认识的 Line。
 * 壁纸这边没有逐字时间轴（原生只存了整行起止），所以整行当成一个「词」，
 * 逐字高亮会退化成整行推进 —— 这是试点阶段的已知差别。
 */
const toLines = (payload: WallpaperPayload): Line[] => {
    const lines = payload.lines ?? [];
    if (lines.length === 0) return NO_LYRIC_LINES;
    return lines.map((line, index) => ({
        id: `wp-${payload.firstIndex ?? 0}-${index}`,
        fullText: line.text,
        startTime: msToSec(line.start),
        endTime: msToSec(line.end),
        translation: line.translation,
        words: [{
            text: line.text,
            startTime: msToSec(line.start),
            endTime: msToSec(line.end),
        }],
    }));
};

const WallpaperSurface: React.FC = () => {
    // 全量订阅设置：壁纸页面没有性能敏感的交互，多渲染几次无所谓。
    // 这三个 store 和播放页读的是同一份（叠层 origin 与主 WebView 相同，localStorage 共享），
    // 所以播放设置里的开关不需要再从原生传一遍。
    const settings = useVisualizerSettingsStore();
    const typography = useTypographySettingsStore();
    const themeSettings = useThemeSettingsStore();
    const payload = React.useSyncExternalStore(
        (notify) => {
            subscribers.add(notify);
            return () => subscribers.delete(notify);
        },
        () => latest,
    );

    const currentTime = useMotionValue(0);
    const { audioPower, audioBands } = useSilentAudio();
    const [currentLineIndex, setCurrentLineIndex] = React.useState(-1);
    const [isDaylight, setIsDaylight] = React.useState(false);

    // 主题色的平滑值（见 stepColorTowards）：null 表示还没有首份颜色，走 payload 原值。
    const [smoothAccent, setSmoothAccent] = React.useState<string | null>(null);
    const [smoothBase, setSmoothBase] = React.useState<string | null>(null);
    const accentRef = React.useRef<string | null>(null);
    const baseRef = React.useRef<string | null>(null);
    // 主文本色 / 次色也走同一套平滑：它们现在是 App 主题的一部分，
    // 换歌（换主题）时同样是瞬间替换，不插值的话歌词颜色会硬跳一下。
    const [smoothPrimary, setSmoothPrimary] = React.useState<string | null>(null);
    const [smoothSecondary, setSmoothSecondary] = React.useState<string | null>(null);
    const primaryRef = React.useRef<string | null>(null);
    const secondaryRef = React.useRef<string | null>(null);

    const lines = React.useMemo(() => toLines(payload), [payload]);
    const tunings = React.useMemo(
        () => collectVisualizerTunings(settings as unknown as Record<string, unknown>),
        [settings]);

    /**
     * 主题必须**整体由原生推来的颜色构建**，不能拿内置主题打底再改两个字段。
     *
     * 内置那对明暗主题是从封面随机生成的，颜色之间本来没有约束；
     * 只覆盖背景色和高亮色、留下 primary/secondary 不管的话，
     * 有些模式（比如商籁）用的正是 secondary —— 于是歌词就变成"绿不拉几"的随机色。
     * 这里让四个颜色都来自同一个高亮色，观感才是自洽的。
     */
    const dualTheme = React.useMemo(() => buildBuiltinDualTheme(), []);
    const theme = React.useMemo<Theme>(() => {
        /*
         * 打底用的是 App 推下来的整份主题（有就优先），内置主题只当兜底。
         *
         * 内置主题补的是「App 没推主题时」的情况（旧包 / 首份数据还没到），
         * 而 App 推下来的那份里带着 AI 主题的 wordColors / lyricsIcons 等一整套字段 ——
         * 这些是内置主题**永远不可能有**的，只覆盖四个颜色就拿不到。
         * 仍然铺一层内置主题在下面：万一 App 那份缺字段（旧包），不至于整块是空的。
         */
        const skeleton = isDaylight ? dualTheme.light : dualTheme.dark;
        const base = payload.theme ? { ...skeleton, ...payload.theme } : skeleton;
        /*
         * 颜色一律走平滑值：换歌时 payload 里的主题色是瞬间替换的，
         * 直接用会让整个可视化的配色硬跳一下（「还是上一个主题色，然后突然变色」）。
         * smooth 值在 rAF 里向目标插值（首份直接落位），过渡约 600ms。
         * smooth 还是 null（首份颜色没到）时退回 payload 原值，行为与之前一致。
         */
        const accent = smoothAccent || payload.accent || skeleton.accentColor;
        /*
         * 主文本色 / 次色一律用 App 推下来的那一份。
         *
         * 之前这两个是从高亮色派生的（主色 = 高亮色、次色 = 高亮色混白），
         * 于是叠层的配色只由高亮色决定：App 里换成 AI / 自定义主题之后，
         * 高亮色跟着变了、文本色却还是按"高亮色"那一套算出来的 ——
         * 叠层看着就是「主题没换」。现在直接用 App 那份，两边才是一套。
         */
        const primary = smoothPrimary || payload.primaryColor || accent;
        return {
            ...base,
            name: 'wallpaper',
            backgroundColor: smoothBase || payload.backgroundColor || skeleton.backgroundColor,
            primaryColor: primary,
            accentColor: accent,
            /*
             * 次色必须和主色拉开明度，不能直接等于主色。
             *
             * 有些模式拿次色画**当前行**高亮；主色常常是从封面取出来的暗色，
             * 一旦等于背景色，那一行就等于隐形了（用户报的「有一句歌词和背景同色」）。
             * 朝白色混一档，既和主色同源，又保证在任何底色上都看得见。
             */
            secondaryColor: smoothSecondary || payload.secondaryColor || lightenColor(accent, 0.5),
        };
    }, [dualTheme, isDaylight, smoothAccent, smoothBase, smoothPrimary, smoothSecondary,
        payload.accent, payload.backgroundColor, payload.primaryColor, payload.secondaryColor,
        payload.theme]);

    React.useEffect(() => {
        // 主题跟随系统深浅色，和播放页的判定保持一致。
        const query = window.matchMedia('(prefers-color-scheme: light)');
        const apply = () => setIsDaylight(query.matches);
        apply();
        query.addEventListener('change', apply);
        return () => query.removeEventListener('change', apply);
    }, []);

    React.useEffect(() => {
        let frame = 0;
        let lastTickAt = performance.now();
        const tick = () => {
            const now = performance.now();
            const dtMs = Math.max(0, now - lastTickAt);
            lastTickAt = now;
            const positionMs = positionMsNow();
            currentTime.set(msToSec(positionMs));
            // 当前行：取最后一条 start <= 当前位置的行，和原生 indexAt 的规则一致。
            // 二分查找：每帧 forEach 扫全表在几百行的歌上是无谓的开销。
            const list = latest.lines ?? [];
            let low = 0;
            let high = list.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (list[mid]!.start <= positionMs) {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            const index = low - 1;
            setCurrentLineIndex(previous => (previous === index ? previous : index));
            // 主题色平滑逼近目标（latest 是原生推来的最新 payload）：
            // 过渡期间每帧推进一次，收敛后 stepColorTowards 返回 undefined，不再重渲染。
            const nextAccent = stepColorTowards(accentRef.current, latest.accent, dtMs);
            if (nextAccent !== undefined) {
                accentRef.current = nextAccent;
                setSmoothAccent(nextAccent);
            }
            const nextBase = stepColorTowards(baseRef.current, latest.backgroundColor, dtMs);
            if (nextBase !== undefined) {
                baseRef.current = nextBase;
                setSmoothBase(nextBase);
            }
            const nextPrimary = stepColorTowards(primaryRef.current, latest.primaryColor, dtMs);
            if (nextPrimary !== undefined) {
                primaryRef.current = nextPrimary;
                setSmoothPrimary(nextPrimary);
            }
            const nextSecondary = stepColorTowards(secondaryRef.current, latest.secondaryColor, dtMs);
            if (nextSecondary !== undefined) {
                secondaryRef.current = nextSecondary;
                setSmoothSecondary(nextSecondary);
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [currentTime]);

    /**
     * 播放设置里的排版 / 字幕开关。
     *
     * 这些字段散在 typography store 里，类型上有几个是 `number | null`、
     * 甚至 store 侧的宽松类型，直接逐个写 prop 会被 TS 判成 unknown 不匹配 ——
     * 而它们对渲染器的语义是明确的，这里统一 spread 一次并断言成渲染器的 props。
     */
    const typographyProps = React.useMemo(() => ({
        lyricsFontScale: typography.lyricsFontScale,
        lyricsFontStyle: typography.lyricsFontStyle,
        lyricsFontWeight: typography.lyricsFontWeight,
        subtitleFontScale: typography.subtitleFontScale,
        subtitleFontStyle: typography.subtitleFontStyle,
        subtitleFontWeight: typography.subtitleFontWeight,
        showSubtitleTranslation: typography.showSubtitleTranslation,
        hideTranslationSubtitle: typography.hidePlayerTranslationSubtitle,
        subtitleContentMode: typography.subtitleContentMode,
        subtitleOverlayOpacity: typography.subtitleOverlayOpacity,
        showHarmonySubtitle: typography.showHarmonySubtitle,
        /*
         * 这三项在叠层里**强制关闭**，不跟随后台设置。
         *
         * 它们的默认值都是 true，作用是在播放页给字幕垫一块背板 / 把未唱到的行糊掉，
         * 好让歌词在满屏画面里读得清。但它们在实现上是拿 `theme.backgroundColor`
         * 画一片近乎不透明的径向渐变 —— 叠层本来就浮在原生壁纸之上，
         * 这一片就是用户看到的「灰色遮罩」，正好把壁纸糊掉。
         * 壁纸叠层的意义就是透出壁纸，所以这里不接受后台的这几项开关。
         */
        subtitleOverlayBackground: false,
        subtitleUpcomingLyricsBlur: false,
        harmonySubtitleBackground: false,
    }) as Partial<React.ComponentProps<typeof VisualizerRenderer>>, [typography]);

    const mode = (payload.visualizer as VisualizerMode)
        || (settings.visualizerMode as VisualizerMode);

    /*
     * 还没收到任何数据（页面刚加载 / 原生还没推第一份）时，**什么都不画**。
     *
     * 这不是省事，是安全网：没有数据就没有正确的主题色和歌词，可视化此时会拿
     * 自己的默认值画一版 —— 在壁纸上看就是一层莫名其妙的灰底，
     * 而且用户会以为"参数没生效"。空着至少是干净的（透出壁纸）。
     */
    const hasData = Boolean(payload.title) || (payload.lines?.length ?? 0) > 0;

    /*
     * 「内容真的画出来了」的标记。判据比"有没有画布"严一格：画布 / 第一层内容
     * 必须**稳定存在一段时间**（见下面 CONTENT_DWELL_MS）才认。
     *
     * 初值取模块级的 `contentPainted`：重新挂载（切歌的空档）不该再淡入一次。
     */
    const [contentReady, setContentReady] = React.useState(() => contentPainted);

    /*
     * 数据到位之后，等可视化真的画出第一帧，再告诉原生"可以淡入了"。
     * 找不到画布（纯 CSS 模式）时看挂载出来的内容，两者都没有就等到超时上限。
     * 注意：这个 effect 必须在下面那个早返回**之前** —— 有条件的 hook 会让 hook 数量变化。
     */
    React.useEffect(() => {
        if (!hasData) return undefined;
        let cancelled = false;
        let seenAt = 0;
        const deadline = performance.now() + 4500;
        const mark = () => {
            if (cancelled) return;
            // 再放两帧：就位的那一刻画布多半还是空的，真正的第一帧在它之后。
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (cancelled) return;
                contentPainted = true;
                setContentReady(true);
                window.__foliaWallpaperPainted = true;
            }));
        };
        const look = () => {
            if (cancelled) return;
            const stage = document.getElementById('wallpaper-stage');
            const canvas = stage?.querySelector('canvas') ?? null;
            const mounted = Boolean(canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0)
                || Boolean(stage && stage.firstElementChild
                    && stage.getBoundingClientRect().height > 0);
            const now = performance.now();
            if (mounted) {
                if (seenAt === 0) {
                    seenAt = now;
                }
                if (now - seenAt >= CONTENT_DWELL_MS) {
                    mark();
                    return;
                }
            } else if (now > deadline) {
                // 到点了还没等到：先出来再说，不能为了一个信号把歌词一直藏着。
                mark();
                return;
            }
            window.setTimeout(look, 80);
        };
        /*
         * 先等自定义歌词字体就绪（最多 1.5 秒）再去找内容。
         *
         * 字体是异步加载的，而画布往往更早就有：只看画布的话 painted 信号会提前放行，
         * 原生开始淡入；等字体真正就绪、歌词以正确姿态画出来的那一刻，窗口已经
         * 完全不透明 —— 用户看到的就是「翻译淡入正常、歌词突然出现」。
         * 把字体这一环并入首帧判定，淡入的起点就落在「歌词真的画好了」之后，
         * 整页（歌词、翻译、背景）一起渐显。
         */
        const fonts = document.fonts;
        if (fonts && fonts.ready) {
            Promise.race([
                fonts.ready,
                new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
            ]).then(look);
        } else {
            look();
        }
        return () => {
            cancelled = true;
        };
    }, [hasData]);

    if (!hasData) {
        return null;
    }

    // 铺满原生钉好的那个根节点。别再用 fixed inset-0：那是按视口算的，
    // 视口和窗口不一致时又会对不上。
    return (
        
        /*
         * 舞台必须给**显式像素**尺寸，不能只给 100%：
         * 里面的外壳是 `w-full h-full`（height:100%），百分比链上只要有一环是 auto，
         * 高度就塌成 0 —— 而可视化的画布是从宿主元素的 clientHeight 量的，
         * 量到 0 就落到它内部的兜底下限（240），于是只画出顶上一条。
         * 这里直接把原生给的尺寸写成 px，链路就断不了。
         */
        <div
            id="wallpaper-stage"
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: stageSize.width,
                height: stageSize.height,
                minHeight: stageSize.height,
                overflow: 'hidden',
                /*
                 * 内容自己也淡进来一次，不完全依赖原生那一层窗口透明度。
                 *
                 * 原生那边是按「页面回报首帧」开始淡入的，而各模式的懒加载节奏差很多：
                 * 有的模式先出歌词、动态背景慢半拍（得多拉一个 chunk / 编译一次着色器），
                 * 等到它出现时窗口已经全不透明 —— 那一帧就是硬蹦出来的。
                 * 这里在同样那个时刻起跑一段 640ms 的 CSS 淡入，比刚刚标记的时刻晚到
                 * 几百毫秒的内容仍然是被"渐显"托着进来的，而不是突然出现。
                 */
                opacity: contentReady ? 1 : 0,
                transition: 'opacity 640ms ease-out',
            }}
        >
            <VisualizerRenderer
                mode={mode}
                currentTime={currentTime}
                currentLineIndex={currentLineIndex}
                lines={lines}
                theme={theme}
                subtitleTheme={theme}
                isDaylight={isDaylight}
                audioPower={audioPower}
                audioBands={audioBands}
                songTitle={payload.title}
                songArtist={payload.artist}
                showText
                seed={payload.title || 'folia-wallpaper'}
                paused={!payload.playing}
                visualizerOpacity={settings.visualizerOpacity}
                /*
                 * transparent: 叠层不画自己的背景层 —— 底下那层原生壁纸（封面 / 模糊 / 纯色）
                 * 才是背景。不这么做的话，可视化会再糊一层半透明底，用户看到的就是
                 * 「壁纸蒙了一层灰雾」。
                 */
                /*
                 * 只要 mode + transparent，**不要**带 common。
                 *
                 * 带上 common（哪怕只是把后台设置原样传一遍）会让可视化按那些参数
                 * 再画一层自己的背景：叠层本来就盖在原生壁纸之上，这一层就是用户看到的
                 * 「灰色遮罩」。透明背景这一条是这个页面存在的全部意义，不能被后台设置覆盖。
                 */
                background={{
                    mode: settings.visualizerBackgroundMode,
                    transparent: true,
                }}
                visualizerTunings={tunings}
                staticMode={themeSettings.staticMode}
                {...typographyProps}
            />
        </div>
    );
};

/**
 * 把根节点钉死在原生给的尺寸上。
 *
 * 不能用 100vw/100vh：WebView 的布局视口和窗口实际大小不一定一致，
 * 可视化在挂载那一刻读到多宽，画布就定死多宽 —— 结果就是画面只占屏幕一部分，
 * 而且横竖屏都不对。尺寸从原生传进来（CSS 像素），是唯一确定的来源。
 */
const pinToNativeSize = (element: HTMLElement) => {
    const params = new URLSearchParams(window.location.search);
    const width = Number(params.get('w'));
    const height = Number(params.get('h'));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return false;
    }
    document.documentElement.style.width = `${width}px`;
    document.documentElement.style.height = `${height}px`;
    document.body.style.width = `${width}px`;
    document.body.style.height = `${height}px`;
    element.style.position = 'fixed';
    element.style.left = '0';
    element.style.top = '0';
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    return true;
};

/**
 * 原生经 URL 传进来的舞台尺寸（CSS 像素），直接当 px 用。
 * 拿不到时退回 100%，但正常路径上一定有。
 */
/**
 * 把颜色朝白色混 `ratio`（0~1）。用于从主色派生出一个更亮、仍然同源的次色。
 * 认不出来就原样返回 —— 这里宁可少变也不要给出错误的颜色。
 */
const lightenColor = (color: string, ratio: number): string => {
    const matched = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (!matched) return color;
    let hex = matched[1];
    if (hex.length === 3) {
        hex = hex.split('').map(char => char + char).join('');
    }
    const channels = [0, 2, 4].map((offset) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16);
        return Math.round(value + (255 - value) * ratio);
    });
    return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}`;
};

const parseHexColor = (color: string): [number, number, number] | null => {
    const matched = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (!matched) return null;
    let hex = matched[1];
    if (hex.length === 3) {
        hex = hex.split('').map(char => char + char).join('');
    }
    return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
    ];
};

const rgbToHex = (channels: readonly number[]): string =>
    `#${channels.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`;

/**
 * 主题色过渡的时间常数（毫秒）。
 *
 * 换歌时新主题色是**瞬间替换**进 payload 的：直接用的话，整个可视化的配色
 * 会从上一首的颜色硬跳到下一首的颜色 —— 用户看到的就是
 * 「一开始还是上一个主题色，然后突然变色」。这里在 rAF 里向目标色平滑逼近，
 * 观感是「颜色流过去」，而不是「换了张皮」。
 */
const THEME_COLOR_TRANSITION_MS = 600;

/**
 * 把当前色朝目标色推进一步（指数逼近，起步快收尾缓，和淡入淡出同一族节奏）。
 * 返回 undefined 表示无需变更；返回 null 表示目标为空（交给主题兜底）。
 * 首份颜色直接落位（不从前一状态或黑色渐变过来）；剩余距离小到一步以内时贴齐，
 * 不让浮点尾数拖着永远不结束。
 */
const stepColorTowards = (
    current: string | null,
    targetHex: string | undefined,
    dtMs: number,
): string | null | undefined => {
    const target = targetHex && targetHex.trim() ? targetHex : null;
    if (target === current) return undefined;
    if (current === null || target === null) return target;
    const from = parseHexColor(current);
    const to = parseHexColor(target);
    if (!from || !to) return target;
    const t = Math.min(0.5, dtMs / THEME_COLOR_TRANSITION_MS);
    const mixed = from.map((channel, index) => channel + (to[index] - channel) * t);
    const remaining = Math.max(...to.map((channel, index) => Math.abs(channel - mixed[index])));
    if (remaining < 1.5) return target;
    return rgbToHex(mixed);
};

const stageSize = (() => {
    const params = new URLSearchParams(window.location.search);
    const width = Number(params.get('w'));
    const height = Number(params.get('h'));
    return {
        width: Number.isFinite(width) && width > 0 ? `${width}px` : '100%',
        height: Number.isFinite(height) && height > 0 ? `${height}px` : '100%',
    };
})();

/**
 * 把「画布 → 舞台」这条祖先链逐级强制撑满。
 *
 * 为什么不能只靠给舞台写死像素：可视化的外壳是 `w-full h-full`（百分比高度），
 * 中间只要有一环是 auto，高度就塌 —— 实测外壳只有 268、宿主 0，
 * 结果画布落到 Pixi runtime 里的兜底下限（240），只画出顶上一条。
 * 而中间那几层是各个可视化模式自己的 DOM，不可能逐个去改。
 *
 * 所以从画布往上走，只给它**这一条**祖先链写 height:100%：
 * 不碰歌词、装饰等旁支元素，风险最小。
 */
/**
 * 把「舞台 → 外壳」这一段撑满。
 *
 * 教训：**不能用一条覆盖前三层的全局 CSS 规则**（`height:100% !important`）——
 * 试过，结果把各模式自己的布局一起改了：齿轮被拉伸、歌词消失、有的模式整个不渲染。
 * 那些层里有各模式有意指定的尺寸（定比舞台、装饰物），一刀切必然误伤。
 *
 * 也不能只照着 canvas 找祖先：纯 CSS 布局的模式根本没有 canvas，
 * 链上照样有 auto 层，内容就偏出屏幕中心。
 *
 * 所以这里只做一件事：从**外壳**往上把祖先链撑满，并让外壳自身 100%。
 * 外壳之上是纯容器，改它们没有任何副作用；外壳之内一律不碰。
 */
const forceShellToFill = () => {
    const stage = document.getElementById('wallpaper-stage');
    if (!stage) return;
    // 外壳：VisualizerShell 的根（w-full h-full flex flex-col …）。
    const shell = stage.querySelector('.w-full.h-full.flex') as HTMLElement | null;
    if (!shell) return;

    if (shell.style.height !== '100%') {
        shell.style.height = '100%';
        shell.style.minHeight = '100%';
    }
    // 外壳与舞台之间的中间层（懒加载包装之类）也一并撑起来。
    let element = shell.parentElement;
    while (element && element !== stage) {
        // 只在真的不一样时才写：反复写同一个值会不停触发 ResizeObserver，
        // 而某些模式（莫奈那类带滤镜的）在 resize 后会重算滤镜目标，
        // 反复重算就会出现发光异常。
        if (element.style.height !== '100%') {
            element.style.height = '100%';
            element.style.minHeight = '100%';
        }
        element = element.parentElement;
    }
};

/**
 * 画布这条链单独再撑一次。
 *
 * 前面那个是按外壳找的，正常情况够用；但有的模式把 canvas 挂在
 * 外壳之外的容器里（背景层），那条链跟外壳链不是同一条。
 */
const forceCanvasChainToFill = () => {
    const stage = document.getElementById('wallpaper-stage');
    if (!stage) return;
    const canvas = stage.querySelector('canvas');
    if (!canvas) return;
    let element: HTMLElement | null = canvas.parentElement;
    while (element && element !== stage) {
        /*
         * 只修**确实塌了**的那一环（高度为 0）。
         *
         * 之前这里是"进了外壳就不再往上改"，结果把最需要修的链挡住了：
         * 外壳已经是 1067，但外壳内部还有一层塌掉的容器，画布照样被卡在兜底下限 240。
         *
         * 反过来也不能无脑全改 —— 某些模式有意把容器设成特定尺寸（定比舞台、装饰层）。
         * 高度恰好为 0 只可能是链断了，不可能是哪种设计（那样什么也看不见），
         * 所以拿这个当判据，既不误伤又能修好塌陷。
         */
        if (element.clientHeight === 0) {
            element.style.height = '100%';
            element.style.minHeight = '100%';
        }
        element = element.parentElement;
    }
};

/** 等两帧：WebView 刚创建时尺寸可能还是 0，布局稳定后才是真的。 */
const afterLayout = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

const container = document.getElementById('wallpaper-root');
if (container) {
    pinToNativeSize(container);
    void afterLayout().then(() => {
        // 挂载前先撑一次，挂载后头几秒再补几次 —— 可视化是懒加载的，
        // 画布出现的时机不确定（还在动态 import 里），第一次多半找不到 canvas。
        const fillAll = () => {
            forceShellToFill();
            forceCanvasChainToFill();
        };
        let remaining = 30;
        const timer = window.setInterval(() => {
            fillAll();
            if (--remaining <= 0) window.clearInterval(timer);
        }, 100);
        window.addEventListener('resize', fillAll);
        // 布局落定后再通知一次：可视化内部若监听 resize 重新量尺寸，这一次才是准的。
        window.dispatchEvent(new Event('resize'));
        ReactDOM.createRoot(container).render(
            <React.StrictMode>
                <WallpaperSurface />
            </React.StrictMode>,
        );
    });
}
