import React from 'react';
import { useMotionValue } from 'framer-motion';
import VisualizerRenderer from '../components/visualizer/VisualizerRenderer';
import { collectVisualizerTunings } from '../utils/visualizer/tunings';
import { buildBuiltinDualTheme } from '../hooks/themeControllerState';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import { useTypographySettingsStore } from '../stores/useTypographySettingsStore';
import { useThemeSettingsStore } from '../stores/useThemeSettingsStore';
import type { Theme, VisualizerMode } from '../types';
import { getWallpaperSnapshot, isWallpaperContentPainted, markWallpaperContentPainted, positionMsNow, subscribeWallpaperPayload } from './wallpaperSurfaceBridge';
import { resolveLyricsFontFamily } from './wallpaperSurfaceFonts';
import { stageSize } from './wallpaperSurfaceLayout';
import { msToSec, toLines } from './wallpaperSurfaceLines';
// 四个颜色的来源判定与平滑都在这里：见 resolveWallpaperColors / stepColorTowards 的注释。
import { resolveWallpaperColors, stepColorTowards } from './wallpaperSurfaceTheme';
import { useBridgedAudio } from './useWallpaperBridgedAudio';

// src/entries/WallpaperSurfaceView.tsx
// The page mounted in the wallpaper WebView: the same VisualizerRenderer as the player page,
// driven by the payload the native side pushes. The entry beside it only bootstraps the page.

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
 * 群唱自定义图的空数组：身份必须稳定，不能每次渲染都新建一个 []。
 * 可视化那边把它当 props 依赖，新建一次就等于「配置变了」，会把头像层重建一遍。
 */
const NO_CAPPELLA_IMAGES: never[] = [];

/**
 * 叠层的内容要**等 payload 安静下来**才画。
 *
 * 为什么：切歌不是一次到位，是**分几拍**补齐的 —— 先来歌名（歌词还是空表），
 * 歌词解析完再来一拍（带整条时间轴），AI 主题往往还要再去云端拉一次 / 打一次模型。
 * 每一拍都会经桥往这里推一份新 payload，照着画就是肉眼可见地「闪两三下」：
 * 内容先冒出来，再被下一拍换掉，中间还夹一次配色硬跳（换主题色时尤其明显）。
 *
 * 所以反过来：收到数据先**藏着**，等这几拍都到齐、连续这么久没再变，才一次性画出来。
 * 900ms 跟原生那边 tuning 落定的窗口（TUNING_SETTLE_MS）是同一个量级，
 * 于是「主题落定 → 整页重载」这一下正好落在藏着的时候，用户看不见。
 */
const SURFACE_SETTLE_MS = 900;

/**
 * 藏着的上限：payload 一直抖（连着自动切歌、歌词反复重解析）也不能让歌词永远不出来。
 * 到点就照当前这一版画 —— 藏是为了**不闪**，不是为了不显示。
 */
const SURFACE_REVEAL_DEADLINE_MS = 2500;

const WallpaperSurface: React.FC = () => {
    // 全量订阅设置：壁纸页面没有性能敏感的交互，多渲染几次无所谓。
    // 这三个 store 和播放页读的是同一份（叠层 origin 与主 WebView 相同，localStorage 共享），
    // 所以播放设置里的开关不需要再从原生传一遍。
    const settings = useVisualizerSettingsStore();
    const typography = useTypographySettingsStore();
    const themeSettings = useThemeSettingsStore();
    const payload = React.useSyncExternalStore(subscribeWallpaperPayload, getWallpaperSnapshot);

    const currentTime = useMotionValue(0);
    const { audioPower, audioBands } = useBridgedAudio();
    const [currentLineIndex, setCurrentLineIndex] = React.useState(-1);
    const [isDaylight, setIsDaylight] = React.useState(false);
    /*
     * 本 document 里注册好的歌词字体族名（还没有 / 没有自定义字体时是 null）。
     *
     * 顺序有讲究：它必须**早于**下面那个「等字体就绪再报首帧」的判定 ——
     * 那份判定等的是 `document.fonts.ready`，字体是这里注册进去的，
     * 注册晚了首帧信号会先放行，原生开始淡入，等字体落地时窗口已经不透明 ——
     * 用户看到的就是「歌词突然蹦出来」。
     */
    const [lyricsFontFamily, setLyricsFontFamily] = React.useState<string | null>(null);
    const lyricsFontMode = settings.wallpaperLyricsFontMode;
    const lyricsFontId = typography.lyricsCustomFont?.fontId ?? null;
    /* 缺字时的兜底栈：自定义字体常常不含全部字形，靠它接住。 */
    const lyricsFallbackFamilies = typography.lyricsFontFallbackFamilies;
    React.useEffect(() => {
        let cancelled = false;
        void resolveLyricsFontFamily(lyricsFontMode).then(family => {
            if (cancelled) return;
            setLyricsFontFamily(family);
        });
        return () => {
            cancelled = true;
        };
    }, [lyricsFontMode, lyricsFontId]);

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
     * 内置那对明暗主题是从封面随机生成的（`buildBuiltinDualTheme()` 不传参数时
     * `random` 就是 `Math.random`），颜色之间本来没有约束，**每重载一次都不一样**；
     * 只覆盖背景色和高亮色、留下 primary/secondary 不管的话，
     * 有些模式（比如商籁）用的正是 secondary —— 于是歌词就变成"绿不拉几"的随机色。
     * 四个颜色到底各走哪一路、缺的时候怎么兜，全部收敛到
     * `resolveWallpaperColors` 一处（见它上面那段），这里只负责把平滑值喂进去。
     */
    const dualTheme = React.useMemo(() => buildBuiltinDualTheme(), []);
    const colors = React.useMemo(() => resolveWallpaperColors({
        /*
         * 四个颜色一律走平滑值：换歌时 payload 里的主题色是瞬间替换的，
         * 直接用会让整个可视化的配色硬跳一下（「还是上一个主题色，然后突然变色」）。
         * smooth 值在 rAF 里向目标插值（首份直接落位），过渡约 600ms。
         * smooth 还是 null（首份颜色没到）时退回 payload 原值，行为与之前一致。
         */
        accent: smoothAccent || payload.accent,
        backgroundColor: smoothBase || payload.backgroundColor,
        // 主文本色 / 次色也走同一套平滑（见上面 smoothPrimary / smoothSecondary 的说明）。
        primaryColor: smoothPrimary || payload.primaryColor,
        secondaryColor: smoothSecondary || payload.secondaryColor,
        // 整份主题：它带着 AI 主题的 wordColors / lyricsIcons，也给四个颜色当第二来源。
        theme: payload.theme,
        skeleton: isDaylight ? dualTheme.light : dualTheme.dark,
        isDaylight,
    }), [dualTheme, isDaylight, smoothAccent, smoothBase, smoothPrimary, smoothSecondary,
        payload.accent, payload.backgroundColor, payload.primaryColor, payload.secondaryColor,
        payload.theme]);
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
        return {
            ...base,
            name: 'wallpaper',
            /*
             * 四个颜色全部来自 `resolveWallpaperColors`（顺序：整包 → 整份主题 →
             * 由高亮色派生 → 内置）。这里不再就地拼兜底：散在这三五行里的 `||` 链
             * 正是之前「高亮色到了、另外三个退回内置随机色」没人察觉的原因。
             *
             * 派生那一支里次色朝白色混一档、不直接等于主色：有些模式拿次色画**当前行**
             * 高亮，主色常常是封面取出来的暗色，一旦和背景同色那一行就等于隐形
             * （用户报的「有一句歌词和背景同色」）。
             */
            backgroundColor: colors.backgroundColor,
            primaryColor: colors.primaryColor,
            accentColor: colors.accent,
            secondaryColor: colors.secondaryColor,
            /*
             * 歌词字体：只在**这一页注册成功了**才往主题上写。
             *
             * 叠层是另一个 document，主窗口 `FontFace` 注册的那份字体在这里一个字都不算 ——
             * 主题里写着一个本页没注册的族名，浏览器会静默退到默认字体，
             * 表现就是「设置里选了字体，桌面叠层一点没变」。
             * 所以这里认的是 `lyricsFontFamily`（resolveLyricsFontFamily 在本页注册成功后返回的名字），
             * 它还是 null（没选字体 / 加载失败 / 正在加载）时保持 base 原样，不去猜。
             *
             * fallback 栈同样要带上：自定义字体常常不含标点或某些字形，
             * 缺字时靠它兜住，否则那几个字会掉成豆腐块。
             */
            fontFamily: lyricsFontFamily ?? base.fontFamily,
            fontFamilyStack: lyricsFallbackFamilies.length ? lyricsFallbackFamilies : base.fontFamilyStack,
        };
    }, [dualTheme, isDaylight, colors, payload.theme, lyricsFontFamily, lyricsFallbackFamilies]);

    /*
     * 配色来源要留一条日志（真机上定位「叠层颜色和 App 对不上」全靠它）。
     *
     * 只在**来源组合或颜色真的变了**时才打：这一份每秒会重渲染很多次，
     * 无条件打会把 logcat / 调试面板刷满，反而看不见换歌那几下。
     * 四种来源的含义见 `WallpaperColorSource`：
     * payload = 随每一份整包推来的；theme = 整份主题 JSON 里的；
     * derived = 由高亮色现算的；builtin = 内置主题兜底（也就是「App 那份根本没到」）。
     */
    const lastColorLogRef = React.useRef('');
    React.useEffect(() => {
        const signature = [
            colors.sources.accent, colors.sources.backgroundColor,
            colors.sources.primaryColor, colors.sources.secondaryColor,
            colors.accent, colors.backgroundColor, colors.primaryColor, colors.secondaryColor,
        ].join('|');
        if (signature === lastColorLogRef.current) return;
        lastColorLogRef.current = signature;
        console.log('[Wallpaper] 叠层配色落定', {
            sources: colors.sources,
            accentColor: colors.accent,
            backgroundColor: colors.backgroundColor,
            primaryColor: colors.primaryColor,
            secondaryColor: colors.secondaryColor,
            themeJson: payload.theme ? 'present' : 'missing',
        });
    }, [colors, payload.theme]);

    /*
     * 画面上**真正决定观感**的那几项拼成的签名。
     *
     * ⚠️ **绝不能**把 positionMs 拼进来：心跳每 500ms 推一次位置，
     * 把它算进签名的话签名永远在变，「等它稳定」就永远等不到，
     * 只能次次靠下面的兜底上限硬放行（等于每次都白等 2.5 秒）。
     *
     * ⚠️ 四个**颜色**也不进签名：它们在上面是走 `stepColorTowards` 平滑过去的
     * （约 600ms），换主题色不会硬跳；把它们算进来反而会让「在主题公园里改个色」
     * 也要先黑一下，而且实验台每次微调都会闪。
     *
     * 只留会**整块换掉画面**的那几项：歌名 / 歌手 / 歌词（行数 + 首行），
     * 以及 AI 主题里没法插值的那两份 —— 指定词上色与可视化图标（它们常常比
     * 颜色晚到，不等它们的话落地时画面还是要变一次，那一下正是「闪」）。
     */
    const surfaceKey = React.useMemo(() => {
        const incoming = payload.theme;
        return [
            payload.title ?? '',
            payload.artist ?? '',
            lines.length,
            lines[0]?.fullText ?? '',
            incoming?.name ?? '',
            incoming?.wordColors?.length ?? -1,
            incoming?.lyricsIcons?.length ?? -1,
        ].join('|');
    }, [payload, lines]);

    /*
     * 藏 / 露：**签名一变就重新藏起来**，安静够 SURFACE_SETTLE_MS 才露。
     *
     * 切歌那几拍（歌名 → 歌词 → 主题）每一拍都会改签名，于是每一拍都把内容按回去、
     * 重新计时 —— 中间那些半成品画面一次都不会画出来。等最后一拍落地、连着 900ms
     * 没再动，才把真正要显示的那一份放出来。
     *
     * 上限那条计时器锚在**第一次变**的时刻（pendingSinceRef），不是最后一次 ——
     * 否则一直抖的话它也跟着一路往后挪，上限就形同虚设了。
     */
    const pendingSinceRef = React.useRef(0);
    const [settledKey, setSettledKey] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (surfaceKey === settledKey) {
            pendingSinceRef.current = 0;
            return undefined;
        }
        const now = performance.now();
        if (pendingSinceRef.current === 0) {
            pendingSinceRef.current = now;
        }
        const reveal = () => {
            pendingSinceRef.current = 0;
            setSettledKey(surfaceKey);
        };
        const settleTimer = window.setTimeout(reveal, SURFACE_SETTLE_MS);
        const deadlineTimer = window.setTimeout(reveal, Math.max(0, SURFACE_REVEAL_DEADLINE_MS - (now - pendingSinceRef.current)));
        return () => {
            window.clearTimeout(settleTimer);
            window.clearTimeout(deadlineTimer);
        };
    }, [surfaceKey, settledKey]);

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
            const list = getWallpaperSnapshot().lines ?? [];
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
            const nextAccent = stepColorTowards(accentRef.current, getWallpaperSnapshot().accent, dtMs);
            if (nextAccent !== undefined) {
                accentRef.current = nextAccent;
                setSmoothAccent(nextAccent);
            }
            const nextBase = stepColorTowards(baseRef.current, getWallpaperSnapshot().backgroundColor, dtMs);
            if (nextBase !== undefined) {
                baseRef.current = nextBase;
                setSmoothBase(nextBase);
            }
            const nextPrimary = stepColorTowards(primaryRef.current, getWallpaperSnapshot().primaryColor, dtMs);
            if (nextPrimary !== undefined) {
                primaryRef.current = nextPrimary;
                setSmoothPrimary(nextPrimary);
            }
            const nextSecondary = stepColorTowards(secondaryRef.current, getWallpaperSnapshot().secondaryColor, dtMs);
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
     * 有数据只是「够画了」，还不代表「该画了」。
     *
     * 主界面那边换歌是分几拍补齐的，payload 会连着变好几回；每一回都够画，
     * 照着画就是「闪两三下」。所以真正放行的条件是签名**稳定住了**
     * （settledKey === surfaceKey），即主界面这一次加载已经落定。
     */
    const surfaceReady = hasData && settledKey === surfaceKey;

    /*
     * 「内容真的画出来了」的标记。判据比"有没有画布"严一格：画布 / 第一层内容
     * 必须**稳定存在一段时间**（见下面 CONTENT_DWELL_MS）才认。
     *
     * 初值取模块级的 `contentPainted`：重新挂载（切歌的空档）不该再淡入一次。
     */
    const [contentReady, setContentReady] = React.useState(() => isWallpaperContentPainted());

    /*
     * 数据到位之后，等可视化真的画出第一帧，再告诉原生"可以淡入了"。
     * 找不到画布（纯 CSS 模式）时看挂载出来的内容，两者都没有就等到超时上限。
     * 注意：这个 effect 必须在下面那个早返回**之前** —— 有条件的 hook 会让 hook 数量变化。
     *
     * 这个「首帧」同样只认**放行之后**（surfaceReady）：藏着的时候画布还没挂，
     * 提前回报的话原生那层就开始淡入了，等真画出来时窗口早已不透明 ——
     * 那又是一次「突然出现」。
     */
    React.useEffect(() => {
        if (!surfaceReady) return undefined;
        let cancelled = false;
        let seenAt = 0;
        const deadline = performance.now() + 4500;
        const mark = () => {
            if (cancelled) return;
            // 再放两帧：就位的那一刻画布多半还是空的，真正的第一帧在它之后。
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (cancelled) return;
                markWallpaperContentPainted();
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
    }, [surfaceReady]);

    if (!surfaceReady) {
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
            data-folia-lyric-surface="wallpaper"
            /*
             * 「歌词改为纯色扁平」在这个页面上要有两个立足点，缺一个就失效：
             * ① 标记 —— index.css 那段规则是 `html[data-lyric-flat] [data-folia-lyric-surface]`，
             *    这里没有这个标记的话，规则在这个 document 里一条都命中不了；
             * ② 变量 —— 规则填的是 `var(--text-primary)`，而那份值是主窗口 App 写在
             *    AppShell 根上的（见 App.tsx 的 appStyle）。叠层是**另一个 document**，
             *    拿不到主窗口那份，也没有第二处在写 —— 不在这里补，填充色会落到 initial
             *    （黑），歌词扁成一团看不清。这里用 App 推下来的同一份主题色补上。
             */
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: stageSize.width,
                height: stageSize.height,
                minHeight: stageSize.height,
                overflow: 'hidden',
                ['--text-primary' as string]: theme.primaryColor,
                ['--text-secondary' as string]: theme.secondaryColor,
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
                /*
                 * 封面：只把它交给可视化自己那一层构图中的封面（莫奈的右侧封面列等），
                 * 底下的背景仍然由原生壁纸负责，所以这里不会去动 transparent。
                 *
                 * 优先用地址：它每首必变、能直接加载；base64 那份只在地址也没有时才用。
                 */
                coverUrl={payload.coverUrl ?? payload.cover ?? null}
                /*
                 * 群唱自定义头像 / 表情图：原生从主应用那边收下来再推给我们（见
                 * WallpaperOverlay.pushCappellaImagesIfChanged）。不传的话这一层的
                 * IndexedDB 是空的，Cappella 会按「没有自定义头像」回退到封面。
                 */
                cappellaCustomAvatarImages={payload.cappellaAvatarImages ?? NO_CAPPELLA_IMAGES}
                cappellaCustomEmojiImages={payload.cappellaEmojiImages ?? NO_CAPPELLA_IMAGES}
                /*
                 * 叠层的封面默认是隐藏的。
                 *
                 * 封面是一整块不透明的方形图，而叠层存在的意义是**透出底下的壁纸**
                 * —— 挂着它等于把壁纸糊掉一大块。所以默认不画，留一个开关
                 * （「桌面叠层显示封面」）给想要那套完整构图的人。
                 */
                hideCoverArt={settings.wallpaperOverlayHideCoverArt !== false}
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
                /*
                 * 告诉可视化「你画在壁纸叠层上」。
                 *
                 * 各模式里凡是有自己底色 / 背板的东西都得据此让开 —— 叠层是浮在原生壁纸
                 * 之上的一层，糊上去一块就等于把壁纸挖掉一块。目前用到它的是浮名那张
                 * 「排版中」的加载卡（它还会每来一份数据闪一次）。
                 */
                isWallpaperSurface
                {...typographyProps}
            />
        </div>
    );
};

export default WallpaperSurface;
