import {
    DEFAULT_STYLE,
    forgetInjectedFamily,
    loadPreviewFamily,
    warmMarketFontFamily,
} from './fontMarket/zeosevenFont';
import type { ZeosevenFont } from './fontMarket/zeosevenCatalog';

/*
 * 目录有 200 多 KB、1300 多款字体，而绝大多数用户从不开字体商店。所以它是**动态载入**
 * 的：第一次用到时才拉这个 chunk，首屏不受牵连。
 */
let catalogPromise: Promise<typeof import('./fontMarket/zeosevenCatalog')> | null = null;
const catalogModule = (): Promise<typeof import('./fontMarket/zeosevenCatalog')> => {
    if (!catalogPromise) catalogPromise = import('./fontMarket/zeosevenCatalog');
    return catalogPromise;
};

// src/services/fontMarket.ts
//
// 字体商店的客户端，数据来自 ZeoSeven Fonts（ZSFT）的免费商用字体库。
//
// 与以前的实现有一个根本区别：字体不再是一个「整包下载」的文件，而是按 unicode-range
// 切成几百个 woff2 的 WebFont。所以这里不再有 fileUrl / fileSize，也不下载整包；预览与
// 正式使用都只登记**需要的分片**（见 fontMarket/zeosevenFont.ts），由浏览器按
// unicode-range 决定实际下发哪几个。
//
// 好处是中文字体从「一次 10–20MB」变成「用多少下载多少」，代价是首次显示某段文字时要
// 等那几个分片到 —— 所以预览会先把常见字预取一份。

/** 预览文字：覆盖常用汉字与拉丁，够看出字体的实际样子。 */
export const PREVIEW_SAMPLE = '永风起时花落无声AaBb';

export interface FontMarketFont {
    /** ZeoSeven 的字体 ID。 */
    id: string;
    name: string;
    /** 用作 CSS family 的名字，运行时由 loadFullFamily 决定，这里只占位。 */
    family: string;
    category: string;
    categoryLabel: string;
    license: string;
    /** 设计师。 */
    designer: string;
    /** 别名 / 英文名。 */
    alias: string;
    /** 语种子集标记。 */
    languages: string[];
    /** 字重数量。 */
    weights: number;
    /** 与旧接口对齐：切片字体没有单一文件地址，留空。 */
    fileName: string;
    mimeType: string;
    fileSize: number;
    fileUrl: string;
    /** 与旧接口对齐：预览不再用预览图，而是直接用字体本身渲染。 */
    previewUrl: string;
    previewAspect: number;
    enabled: boolean;
    sort: number;
    createdAt: string;
    updatedAt: string;
}

export interface FontMarketSelection {
    id: string;
    family: string;
    label: string;
    previewUrl: string;
}

export type FontMarketInstallResult = FontMarketSelection & {
    /**
     * 字体字节（base64）。
     *
     * 切片字体没有「整包字节」可取，这里为空串。壁纸 / 叠层那两层是自绘的，
     * 它们要字体时按 family 走 WebFont（见 ensureMarketFontFamilyForCanvas）。
     */
    base64: string;
};

const toMarketFont = (
    font: ZeosevenFont,
    index: number,
    styleLabel: (style: string) => string,
): FontMarketFont => {
    /*
     * `category` 取**第一个**风格，只用于卡片上那一行小字。筛选不能只看它：一款字体
     * 常常同时带多个风格（比如既是无衬线、又带西里尔），用户点「楷书」时也该找得到它。
     * 真正的筛选走 matchesCategory，比对整个 styles 数组。
     */
    const primaryStyle = font.styles[0] ?? '';
    return {
        id: font.id,
        name: font.name,
        family: `zsft-full-${font.id}-${DEFAULT_STYLE}`,
        category: primaryStyle || 'all',
        categoryLabel: primaryStyle ? styleLabel(primaryStyle) : '全部',
        license: font.license,
        designer: font.designer,
        alias: font.alias,
        languages: font.languages,
        weights: font.weights,
        fileName: '',
        mimeType: 'font/woff2',
        fileSize: 0,
        fileUrl: '',
        previewUrl: '',
        previewAspect: 0,
        enabled: true,
        sort: index,
        createdAt: '',
        updatedAt: '',
    };
};

/*
 * 目录在构建时就烘进了包里（见 fontMarket/zeosevenCatalog.json），所以「拉一页」其实是
 * 在本地数组上做筛选与切片 —— 不再有网络往返，翻页也就没有加载态。
 */
export interface FontMarketQuery {
    page?: number;
    pageSize?: number;
    /** 'all' 或空 = 不过滤；否则是风格标记。 */
    category?: string;
    q?: string;
}

export interface FontMarketResult {
    fonts: FontMarketFont[];
    error: 'offline' | 'server' | null;
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

const matchesCategory = (font: ZeosevenFont, category: string): boolean => (
    category === 'all' || font.styles.includes(category)
);

const matchesQuery = (font: ZeosevenFont, needle: string): boolean => {
    if (!needle) return true;
    const lower = needle.toLowerCase();
    return font.name.toLowerCase().includes(lower)
        || font.alias.toLowerCase().includes(lower)
        || font.designer.toLowerCase().includes(lower);
};

export const fetchFontMarket = async (query: FontMarketQuery = {}): Promise<FontMarketResult> => {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.trunc(query.pageSize ?? 24));
    const category = query.category ?? 'all';
    const needle = (query.q ?? '').trim();

    const { ZEOSEVEN_FONTS } = await catalogModule();
    const filtered = ZEOSEVEN_FONTS.filter((font) => (
        matchesCategory(font, category) && matchesQuery(font, needle)
    ));

    const start = (page - 1) * pageSize;
    const { styleLabel } = await catalogModule();
    const pageFonts = filtered.slice(start, start + pageSize)
        .map((font, offset) => toMarketFont(font, start + offset, styleLabel));

    return {
        fonts: pageFonts,
        error: null,
        total: filtered.length,
        page,
        pageSize,
        hasMore: start + pageFonts.length < filtered.length,
    };
};

/** 全部风格，按目录里出现的顺序 —— 给筛选页签用。 */
export const listFontMarketCategories = async (): Promise<{ value: string; label: string; count: number }[]> => {
    const { ZEOSEVEN_FONTS, styleLabel } = await catalogModule();
    const counts = new Map<string, number>();
    for (const font of ZEOSEVEN_FONTS) {
        for (const style of font.styles) {
            counts.set(style, (counts.get(style) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([value, count]) => ({ value, label: styleLabel(value), count }));
};

/**
 * 预览用的 family：只加载覆盖预览文字的分片，返回可直接写进 CSS 的名字。
 *
 * 拿不到（网络不通 / 站点改版）时返回 null，调用方显示占位而不是退回系统字体。
 */
export const ensureMarketFontPreview = async (fontId: string): Promise<string | null> => (
    loadPreviewFamily(fontId, DEFAULT_STYLE, PREVIEW_SAMPLE)
);

/**
 * 安装一款字体：把全部分片登记进页面，并把选择记下来。
 *
 * 不再有「下载整包 → 存 IndexedDB」这一步：切片字体由浏览器按需取并缓存在 HTTP 层，
 * 落盘也由它管。我们只记住用户选了哪一款。
 */
export const installMarketFont = async (font: FontMarketFont): Promise<FontMarketInstallResult> => {
    /*
     * 用预热样本而不是一小段字：选中之后歌词随时会出现任何字，只唤醒几个分片的话，
     * 其余字在首帧会画成回退字体，而 canvas 样式大多不会因此重绘。
     */
    const family = await warmMarketFontFamily(font.id);
    if (!family) {
        throw new Error('字体加载失败（网络不通或字体源不可用）');
    }

    const selection: FontMarketSelection = {
        id: font.id,
        family,
        label: font.name,
        previewUrl: '',
    };
    writeFontMarketChoice(selection);

    return { ...selection, base64: '' };
};

/** 卸载：把注入的样式表摘掉，避免继续占着文档。 */
export const uninstallMarketFont = (family: string): void => {
    forgetInjectedFamily(family);
};

/** 市场字体的 family 前缀，见 loadFullFamily。 */
const MARKET_FAMILY_PREFIX = 'zsft-full-';

/** 这个 family 是不是字体市场注入的（而不是本机系统字体）。 */
export const isMarketFontFamily = (family: string): boolean => (
    family.trim().startsWith(MARKET_FAMILY_PREFIX)
);

/**
 * 从市场 family 反推出字体 ID。
 *
 * 形如 `zsft-full-292-main` → `292`。认不出时返回 null。
 */
export const marketFontIdFromFamily = (family: string): string | null => {
    const trimmed = family.trim();
    if (!trimmed.startsWith(MARKET_FAMILY_PREFIX)) return null;
    const rest = trimmed.slice(MARKET_FAMILY_PREFIX.length);
    // id 本身可能带 "-"，所以从右边按最后一段是 style 来切。
    const cut = rest.lastIndexOf('-');
    if (cut <= 0) return null;
    const id = rest.slice(0, cut);
    return id || null;
};

/** 面板地址，给「去官网看看」这类入口用。 */
export const resolveFontMarketAdminUrl = (): string => 'https://fonts.zeoseven.com/';

/** 某款字体的详情页。 */
export const resolveFontMarketDetailUrl = (fontId: string): string => (
    `https://fonts.zeoseven.com/items/${fontId}/`
);

// ------------------------------------------------------------------ 本机选择

const CHOICE_STORAGE_KEY = 'foliaFontMarketChoice';

/**
 * 本机当前用着的是哪款市场字体。
 *
 * 只存元信息；字体本身由 ZeoSeven 的 CDN 提供，冷启动时重新登记一次即可
 * （见 restoreMarketFontChoice）。
 */
export const readFontMarketChoice = (): FontMarketSelection | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(CHOICE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FontMarketSelection>;
        if (!parsed?.id || !parsed?.family) return null;
        return {
            id: String(parsed.id),
            family: String(parsed.family),
            label: String(parsed.label ?? parsed.family),
            previewUrl: String(parsed.previewUrl ?? ''),
        };
    } catch {
        return null;
    }
};

export const writeFontMarketChoice = (choice: FontMarketSelection | null): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        if (!choice) localStorage.removeItem(CHOICE_STORAGE_KEY);
        else localStorage.setItem(CHOICE_STORAGE_KEY, JSON.stringify(choice));
    } catch {
        // Quota or private mode: the in-memory font still applies this session.
    }
};

/**
 * 冷启动时把上次选的市场字体重新登记回来。
 *
 * 返回可用的 family；存的那款已经在目录里找不到（站点下架）时返回 null。
 */
export const restoreMarketFontChoice = async (): Promise<string | null> => {
    const choice = readFontMarketChoice();
    if (!choice) return null;
    const { getZeosevenFont } = await catalogModule();
    if (!getZeosevenFont(choice.id)) return null;
    return warmMarketFontFamily(choice.id);
};
