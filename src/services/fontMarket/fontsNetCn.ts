// src/services/fontMarket/fontsNetCn.ts
//
// fonts.net.cn（字体天下）接入。
//
// 全部细节见 `docs/fonts-net-cn-api.md`，那里是实测记录；这里只写代码需要的部分。
//
// 三条链路：
//   列表  GET  /fonts-zh-{page}.html          解析 HTML
//   下载  POST /api/font-download/url         form-urlencoded，返回 zip 地址
//   预览  GET  previewer.fonts.net.cn/canvas.php?font={fontFile}&text={文字}
//
// 预览那个参数名是 `font`，值为详情页 `data-font-file` 的完整内容。
// 传错照样返回 200，只是给一张 1520 字节的空白图 —— 所以界面必须兜底。

import { fetchHtml } from './http';

const BASE = 'https://www.fonts.net.cn';
const PREVIEWER = 'https://previewer.fonts.net.cn/canvas.php';

/**
 * 分类：**照抄源站的导航**，不要自己编。
 *
 * 源站分两层：
 *   · 大类（中文 / 英文 / 图形）—— 顶层路径 `/fonts-{zh,en,pic}-N.html`
 *   · 风格标签 —— `/fonts-zh/tag-{slug}-N.html`
 *
 * 另有大量**厂商**标签（字魂、汉仪、方正…），数量太多（181 个），
 * 全塞进一排按钮会把界面撑爆，所以只挑常用的几个放进「字库」组。
 *
 * `preview` 是这一组该用什么样文预览：英文组用中文样文会渲染成空白
 * （英文字体里没有汉字字形），这是之前英文分类看着"没内容"的真正原因。
 */
export interface FontsCnCategory {
    slug: string;
    label: string;
    /** 预览样文；不给就用组默认。 */
    preview?: string;
    /** 分组，界面上分两排显示。 */
    group: 'type' | 'style' | 'foundry';
}

export const FONTS_CN_CATEGORIES: FontsCnCategory[] = [
    { slug: 'zh', label: '中文', group: 'type', preview: '永风起时花落无声' },
    { slug: 'en', label: '英文', group: 'type', preview: 'The quick brown fox' },
    { slug: 'pic', label: '图形', group: 'type', preview: 'ABC 123' },
    // —— 风格 ——
    { slug: 'zh/tag-heiti', label: '黑体', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-songti', label: '宋体', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-kaiti', label: '楷体', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-xingshu', label: '行书', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-caoshu', label: '草书', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-lishu', label: '隶书', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-maobi', label: '毛笔', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-youyuan', label: '幼圆', group: 'style', preview: '永风起时花落无声' },
    { slug: 'zh/tag-xiangsu', label: '像素', group: 'style', preview: '永风起时花落无声' },
    // —— 常用字库 ——
    { slug: 'zh/tag-zihun', label: '字魂', group: 'foundry', preview: '永风起时花落无声' },
    { slug: 'zh/tag-hanyi', label: '汉仪', group: 'foundry', preview: '永风起时花落无声' },
    { slug: 'zh/tag-fangzheng', label: '方正', group: 'foundry', preview: '永风起时花落无声' },
    { slug: 'zh/tag-siyuan', label: '思源', group: 'foundry', preview: '永风起时花落无声' },
];

/** 这一组默认用什么预览文字。 */
export const categoryPreviewText = (slug: string): string => (
    FONTS_CN_CATEGORIES.find((entry) => entry.slug === slug)?.preview ?? '永风起时花落无声'
);

export interface FontsCnItem {
    /** 数字 ID，接口要的就是它。 */
    id: string;
    name: string;
    /** 列表页的静态预览图，直接可 <img src>。可能为空。 */
    coverUrl: string;
    /** 详情页路径。 */
    detailPath: string;
    /** 渲染自定义文字预览用的键；列表页拿不到，要进详情页。 */
    fontFile?: string;
}

export interface FontsCnPage {
    items: FontsCnItem[];
    hasMore: boolean;
    page: number;
}

/** 分类 slug → 列表页地址。`zh` / `en` / `pic` 是顶层路径，其余是 tag。 */
const listUrl = (category: string, page: number): string => {
    if (category === 'zh' || !category) return `${BASE}/fonts-zh-${page}.html`;
    if (category === 'en') return `${BASE}/fonts-en-${page}.html`;
    if (category === 'pic') return `${BASE}/fonts-pic-${page}.html`;
    return `${BASE}/fonts-${category}-${page}.html`;
};

/**
 * 解析列表页。
 *
 * 卡片结构（实测，见 docs/fonts-net-cn-api.md）：
 * ```html
 * <div class="site_font_list_item_head">
 *   <a href="/font-37476120124.html" title="字魂白鸽天行体">字魂白鸽天行体</a>
 * </div>
 * <div class="site_font_list_item_body">
 *   <a href="/font-37476120124.html">
 *     <img src="//img.cdn.fonts.net.cn/cover-37476-....jpg"
 *          data-font-file="37476-816e....ttf" />
 *   </a>
 *   ...
 * </div>
 * ```
 *
 * 两个要点：
 *   · 卡片里的 `<img>` 自带 `data-font-file`，**列表页就能拿到预览键**，
 *     不用再逐个进详情页（省掉一次请求，列表快很多）。
 *   · 名字优先用 `title`，比 `alt="xxx的封面图"` 干净。
 *
 * 按 `<li>` 切块而不是按 `<a>` 切：一个卡片里有多个 `<a>`（名字、封面、下载），
 * 按 `<a>` 切会把同一款字体拆成好几条。
 */
export const parseFontsCnList = (html: string, page: number): FontsCnPage => {
    const blocks = html.match(/<li>\s*<div class="site_font_list_item_head"[\s\S]*?<\/li>/g) ?? [];
    const items: FontsCnItem[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
        const detailPath = /href="(\/font-\d+\.html)"/.exec(block)?.[1];
        if (!detailPath) continue;

        const id = /\/font-(\d+)\.html/.exec(detailPath)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);

        /*
         * 名字优先级：`.site_font_name` 的 title > 该链接的文字。
         * 刻意不退回「卡片里任意一个 title」—— 那个会取到分类名（「中文字体」），
         * 显示出来是一串同名的假字体。
         */
        const name = (
            /class="site_font_name"[^>]*title="([^"]*)"/.exec(block)?.[1]
            ?? /class="site_font_name"[^>]*>([^<]*)</.exec(block)?.[1]
            ?? ''
        ).trim();

        const coverSrc = /<img[^>]*src="([^"]+)"/.exec(block)?.[1] ?? '';
        const fontFile = /data-font-file="([^"]+)"/.exec(block)?.[1];

        items.push({
            id,
            name: name || `字体 ${id}`,
            coverUrl: coverSrc.startsWith('//') ? `https:${coverSrc}` : coverSrc,
            detailPath,
            fontFile,
        });
    }

    /*
     * 站点每页 10 条（搜索页与列表页都是）。
     * 拿满一页就认为可能还有下一页 —— 没有总数可用，只能这样推断；
     * 猜错的代价只是末尾多一次空请求。
     */
    return { items, hasMore: items.length >= 10, page };
};

export const fetchFontsCnPage = async (
    category: string,
    page: number,
    signal?: AbortSignal,
): Promise<FontsCnPage> => {
    const response = await fetchHtml(listUrl(category, page), { 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal);
    if (!response.ok) {
        throw new Error(`字体天下列表请求失败（HTTP ${response.status}）`);
    }
    return parseFontsCnList(await response.text(), page);
};

/**
 * 搜索。
 *
 * 站点给出的搜索页是 `/font-search-result.html?q=<关键字>&page=<页码>`，
 * 结构和列表页完全一样（同一个解析器就能用），分页也是 `page`。
 *
 * 搜不到时页面正常返回、只是没有卡片，所以「空结果」不是错误 ——
 * 界面要能区分「没搜到」和「请求失败」。
 */
export const searchFontsCn = async (
    keyword: string,
    page: number,
    signal?: AbortSignal,
): Promise<FontsCnPage> => {
    if (!keyword.trim()) {
        return { items: [], hasMore: false, page };
    }
    const url = `${BASE}/font-search-result.html?q=${encodeURIComponent(keyword.trim())}&page=${page}`;
    const response = await fetchHtml(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal);
    if (!response.ok) {
        throw new Error(`搜索请求失败（HTTP ${response.status}）`);
    }
    return parseFontsCnList(await response.text(), page);
};

/**
 * 进详情页拿 `data-font-file` 与 cookie。
 *
 * cookie 是给下载接口用的：下载必须带会话，否则报 FontNotFound。
 */
export const fetchFontsCnDetail = async (
    detailPath: string,
    signal?: AbortSignal,
): Promise<{ fontFile?: string; cookie: string }> => {
    const response = await fetchHtml(`${BASE}${detailPath}`, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal);
    const html = await response.text();
    const fontFile = /data-font-file="([^"]+)"/.exec(html)?.[1];
    /*
     * 原生桥会把 Set-Cookie 丢掉（fetch 语义只暴露最终响应头），
     * 所以 Web 侧拿不到 PHPSESSID —— 会话由原生下载时自己取。
     * 这里保留字段是为了将来原生能回传 cookie。
     */
    return { fontFile, cookie: '' };
};

/** 自定义文字预览图地址；拿不到 fontFile 时返回 null。 */
export const buildFontsCnPreviewUrl = (fontFile: string, text: string): string => (
    `${PREVIEWER}?font=${encodeURIComponent(fontFile)}&text=${encodeURIComponent(text)}`
);

/** 下载接口的失败码 → 面向用户的文案。 */
export const FONTS_CN_ERROR_MESSAGES: Record<string, string> = {
    FontDownloadPurchaseRequired: '此字体需在官网购买后下载',
    FontDownloadLicenseRequired: '此字体需在官网获得授权后下载',
    FontDownloadDisabled: '此字体已停止下载',
    FontNotFound: '找不到这个字体',
    // 原生侧的几个环节，分开报才看得出卡在哪
    RequestFailed: '拿不到下载地址，请稍后重试',
    ArchiveDownloadFailed: '字体包下载失败，请检查网络',
    NoFontInArchive: '这个字体包里没有可用的字体文件',
};

/** 把原生返回的错误码翻译成一句人话。 */
export const describeFontsCnError = (code: string | null | undefined): string => {
    if (!code) return '';
    // DownloadFailed:java.io.IOException 这种，取冒号前那半段
    const head = code.split(':')[0];
    return FONTS_CN_ERROR_MESSAGES[head] ?? code;
};
