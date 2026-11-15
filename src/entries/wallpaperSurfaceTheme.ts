import type { Theme } from '../types';
import { mixHexColors } from '../utils/themeColorMath';

// src/entries/wallpaperSurfaceTheme.ts
// Colour maths for the wallpaper page: the derived secondary colour, the per-frame colour easing
// that keeps a theme change from snapping, and the rule that decides where each of the four
// colours actually comes from.

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
 * 首份颜色直接落位（不从前一状态或黑色渐变过来）；剩余距离小到一步以内、
 * 或者一步量化后根本动不了一个色阶时贴齐，不让浮点尾数拖着永远不结束。
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
    const next = rgbToHex(mixed);
    const remaining = Math.max(...to.map((channel, index) => Math.abs(channel - mixed[index])));
    /*
     * 一步跨不过一个色阶时（8 位量化回来和当前值一模一样）就把剩下的距离直接贴齐。
     *
     * 不贴的话会停在一个「离目标十几阶、每帧算出来都一样」的平台上：颜色永远差一点，
     * rAF 里每帧都还在写同一个值 —— 用户看不出那点差别，但它让过渡永远不结束。
     */
    if (next === current || remaining < 1.5) return target;
    return next;
};

/**
 * 四个颜色各自是从哪一路拿到的。
 *
 * 只给日志用：真机上「叠层配色和 App 对不上」最需要回答的就是这一句 ——
 * 是 App 那份没送到（`builtin` / `derived`），还是送到了但被后面的整包冲掉了。
 */
export type WallpaperColorSource = 'payload' | 'theme' | 'derived' | 'builtin';

export type WallpaperColorSources = {
    accent: WallpaperColorSource;
    backgroundColor: WallpaperColorSource;
    primaryColor: WallpaperColorSource;
    secondaryColor: WallpaperColorSource;
};

export type WallpaperColorInput = {
    /** 平滑之后的四个颜色（rAF 里逼近出来的那份；没有就是 null）。 */
    accent?: string | null;
    backgroundColor?: string | null;
    primaryColor?: string | null;
    secondaryColor?: string | null;
    /** 原生推下来的整份 App 主题。它带着 `wordColors` / `lyricsIcons` 这些非颜色字段。 */
    theme?: Partial<Theme> | null;
    /** 内置主题：**只在前面几条都没有时**兜底。 */
    skeleton: Pick<Theme, 'accentColor' | 'primaryColor' | 'secondaryColor' | 'backgroundColor'>;
    isDaylight: boolean;
};

export type WallpaperColorResolution = {
    accent: string;
    backgroundColor: string;
    primaryColor: string;
    secondaryColor: string;
    sources: WallpaperColorSources;
};

/**
 * 从高亮色派生一个能当底色的深（或浅）色：同源但明度拉开。
 *
 * 换歌、换主题时底色本身是「整页的底」，它不该是中性黑 —— 叠层浮在原生壁纸之上，
 * 底色一旦是纯黑或纯白，它就和自己盖住的那张壁纸脱节。
 */
const deriveBackgroundFromAccent = (accent: string, isDaylight: boolean): string =>
    mixHexColors(accent, isDaylight ? '#ffffff' : '#000000', isDaylight ? 0.9 : 0.86);

/** 空串 / 空白也算「没有」：原生在没拿到值时会把空串塞进 payload。 */
const usable = (value: string | null | undefined): value is string =>
    typeof value === 'string' && value.trim().length > 0;

/**
 * 定下叠层最终用哪四个颜色，并记下每一条的来源。
 *
 * 为什么要有这么一层：这四个颜色本来是两条互不相干的通路送到叠层的 ——
 * 高亮色 / 底色跟着**每一份整包**推（`snapshot.accent` / `snapshot.baseColor`），
 * 主文本色 / 次色 / 整份主题则存在原生那张小表（`WallpaperThemePalette`）里，
 * 只在主 WebView 那一推带上它们时才写进去。于是只要那张表是空的，
 * 叠层的三色就**退回内置主题**——而内置主题是拿封面随机生成的，
 * 跟 App 当前这套配色毫无关系。用户看到的就是任务里那句
 * 「高亮色能出来，主题本体配色没有」。
 *
 * 所以这里把兜底顺序明确写出来，并且**先认 App 那份主题 JSON**：
 *  - 高亮色：整包 accent → 主题里的 accentColor → 内置；
 *  - 底色：整包 backgroundColor → 主题里的 backgroundColor → 由主色派生（不再随机）；
 *  - 主文本色：整包 primaryColor → 主题里的 primaryColor → 高亮色（旧行为）；
 *  - 次色：整包 secondaryColor → 主题里的 secondaryColor → 由高亮色混白（旧行为）。
 *
 * 后两条「旧行为」就是这条分支之前的样子：三色全都由高亮色一个值推出来。
 * 保留它，是为了**只拿到高亮色时画面依旧是一套自洽的配色**，
 * 而不是内置主题那套随机色里掺一个 App 的高亮色。
 */
const resolveWallpaperColors = (input: WallpaperColorInput): WallpaperColorResolution => {
    const { theme, skeleton, isDaylight } = input;

    let accent: string;
    let accentSource: WallpaperColorSource;
    if (usable(input.accent)) {
        accent = input.accent;
        accentSource = 'payload';
    } else if (usable(theme?.accentColor)) {
        accent = theme.accentColor;
        accentSource = 'theme';
    } else {
        accent = skeleton.accentColor;
        accentSource = 'builtin';
    }

    let primaryColor: string;
    let primarySource: WallpaperColorSource;
    if (usable(input.primaryColor)) {
        primaryColor = input.primaryColor;
        primarySource = 'payload';
    } else if (usable(theme?.primaryColor)) {
        primaryColor = theme.primaryColor;
        primarySource = 'theme';
    } else {
        // 旧行为：主文本色 = 高亮色。至少和这一份画面里的高亮是同一套。
        primaryColor = accent;
        primarySource = 'derived';
    }

    let secondaryColor: string;
    let secondarySource: WallpaperColorSource;
    if (usable(input.secondaryColor)) {
        secondaryColor = input.secondaryColor;
        secondarySource = 'payload';
    } else if (usable(theme?.secondaryColor)) {
        secondaryColor = theme.secondaryColor;
        secondarySource = 'theme';
    } else {
        /*
         * 次色必须和主色拉开明度，不能直接等于主色：未唱到的那些行用它，
         * 一旦和主色一样，「唱过 / 没唱过」就分不出来；和底色一样则那一行等于隐形。
         */
        secondaryColor = lightenColor(accent, 0.5);
        secondarySource = 'derived';
    }

    let backgroundColor: string;
    let backgroundColorSource: WallpaperColorSource;
    if (usable(input.backgroundColor)) {
        backgroundColor = input.backgroundColor;
        backgroundColorSource = 'payload';
    } else if (usable(theme?.backgroundColor)) {
        backgroundColor = theme.backgroundColor;
        backgroundColorSource = 'theme';
    } else {
        /*
         * 最后一条不再是内置主题那套随机色：从主色派生出同源底色。
         *
         * 走这一步意味着「这一份整包里连底色都没有」——只有极早的那一拍才会这样。
         * 此时用内置随机色会让整页凭空换一套配色（还每重载一次换一次），
         * 而同源派生至少和屏幕上的歌词是同一套。
         */
        backgroundColor = deriveBackgroundFromAccent(primaryColor, isDaylight);
        backgroundColorSource = 'derived';
    }

    return {
        accent,
        backgroundColor,
        primaryColor,
        secondaryColor,
        sources: {
            accent: accentSource,
            backgroundColor: backgroundColorSource,
            primaryColor: primarySource,
            secondaryColor: secondarySource,
        },
    };
};

export { lightenColor, resolveWallpaperColors, stepColorTowards };
