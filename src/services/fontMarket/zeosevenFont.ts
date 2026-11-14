// src/services/fontMarket/zeosevenFont.ts
//
// ZeoSeven Fonts 的取用逻辑：把 result.css 接住、改写，然后按需只加载命中的字形分片。
//
// 它的字体是按 unicode-range 切成几百个 woff2 的。直接 @import 原版 CSS 也能用，但
// 有两个问题：一是原版带 `local(...)`，机器上装了同名系统字体就**根本不下载**，预览
// 会显示成系统字体；二是预览一段短文本没必要把几百个分片都登记进文档。所以这里把
// CSS 拆成「url + unicode-range」的配对，只注册真正覆盖到文字的那些分片。

/** 两个镜像：主站挂了还有备用。官网自己也是这么兜的。 */
const ORIGINS = [
    'https://fontsapi.zeoseven.com',
    'https://fontsapi-storagedriver.zeoseven.com',
] as const;

export interface ZeosevenSlice {
    /** 绝对地址的 woff2。 */
    url: string;
    /** 该分片覆盖的码点区间。 */
    ranges: { start: number; end: number }[];
}

/** 一次 result.css 的取回结果：分片表 + 这份 CSS 来自哪个域名。 */
interface FetchedFont {
    origin: string;
    slices: ZeosevenSlice[];
}

const FETCH_CACHE = new Map<string, FetchedFont>();
/** 已经注入文档的样式表，按 family 记，避免重复插入。 */
const injectedSheets = new Set<string>();

/** 从 unicode-range 里解析出码点区间。 */
const parseRanges = (raw: string): ZeosevenSlice['ranges'] => {
    const ranges: ZeosevenSlice['ranges'] = [];
    for (const piece of raw.split(',')) {
        const token = piece.trim();
        if (!token.toUpperCase().startsWith('U+')) continue;
        const [from, to] = token.slice(2).split('-');
        const start = Number.parseInt(from, 16);
        if (!Number.isFinite(start)) continue;
        const end = to ? Number.parseInt(to, 16) : start;
        ranges.push({ start, end: Number.isFinite(end) ? end : start });
    }
    return ranges;
};

/**
 * 把一份 result.css 拆成分片表，并把 `./xxx.woff2` 这类相对地址补成绝对地址。
 *
 * 注意路径层级：分片放在 `/<id>/<style>/` 这个子目录下，不是站点根目录。CSS 里写的是
 * `url("./e91db8d04b612105.woff2")`，只把 `./` 去掉会得到 `/<file>` —— 那是 404。
 * 官网自己的做法也是把 `./` 替换成 `/<id>/<style>/`，这里照做。
 */
const parseSlices = (css: string, origin: string, fontId: string, style: string): ZeosevenSlice[] => {
    const slices: ZeosevenSlice[] = [];
    const facePattern = /@font-face\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null = facePattern.exec(css);
    while (match) {
        const body = match[1];
        const url = /url\(\s*['"]?([^)'"]+)['"]?\s*\)/.exec(body)?.[1];
        const range = /unicode-range\s*:\s*([^;}]+)/i.exec(body)?.[1];
        if (url && range) {
            const absolute = /^https?:\/\//i.test(url)
                ? url
                : `${origin}/${fontId}/${style}/${url.replace(/^\.?\//, '')}`;
            slices.push({ url: absolute, ranges: parseRanges(range) });
        }
        match = facePattern.exec(css);
    }
    return slices;
};

/**
 * 取某款字体的分片表。主站不通就换镜像，全部失败返回 null。
 *
 * 缓存按 `<id>/<style>` 记：同一款字体的预览和正式使用共用这一份，不重复下载 CSS。
 */
const fetchFont = async (fontId: string, style: string): Promise<FetchedFont | null> => {
    const key = `${fontId}/${style}`;
    const cached = FETCH_CACHE.get(key);
    if (cached) return cached;

    for (const origin of ORIGINS) {
        try {
            const response = await fetch(`${origin}/${fontId}/${style}/result.css`, {
                method: 'GET',
                headers: { Accept: 'text/css,*/*;q=0.1' },
            });
            if (!response.ok) continue;
            const css = await response.text();
            if (!css.includes('@font-face')) continue;
            const slices = parseSlices(css, origin, fontId, style);
            if (slices.length === 0) continue;
            const fetched: FetchedFont = { origin, slices };
            FETCH_CACHE.set(key, fetched);
            return fetched;
        } catch {
            // 网络错误也换下一个镜像。
        }
    }
    return null;
};

/** 预览文字里出现的全部码点。 */
const codePointsOf = (text: string): number[] => [...text].map((ch) => ch.codePointAt(0) ?? 0);

/** 挑出覆盖任意一个码点的分片。 */
const slicesCovering = (slices: ZeosevenSlice[], codePoints: number[]): ZeosevenSlice[] => (
    slices.filter((slice) => codePoints.some((code) => (
        slice.ranges.some(({ start, end }) => code >= start && code <= end)
    )))
);

/**
 * 用指定分片拼一份只含这些 @font-face 的样式表，并用给定的 family 名注册。
 *
 * 换 family 名是为了避开冲突：同一款字体的预览和正式使用可能同时存在，各自用
 * 不同的 family，互不覆盖。
 */
const sheetFor = (family: string, slices: ZeosevenSlice[]): string => (
    slices.map((slice) => (
        `@font-face{font-family:"${family}";`
        + `src:url("${slice.url}") format("woff2");`
        + 'font-style:normal;font-display:swap;font-weight:400;}'
    )).join('')
);

const injectSheet = (family: string, css: string): void => {
    if (injectedSheets.has(family) || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.dataset.foliaFont = family;
    style.textContent = css;
    document.head.appendChild(style);
    injectedSheets.add(family);
};

const awaitFamily = async (family: string, sample: string): Promise<void> => {
    try {
        await document.fonts.load(`1em "${family}"`, sample);
    } catch {
        // 加载失败也把 family 交回去：浏览器会在字形真正用到时再试一次。
    }
};

/**
 * 准备一款字体的预览：只加载覆盖 `sample` 的分片。
 *
 * 返回可直接写进 CSS 的 family 名；拿不到时返回 null（界面保留占位，不显示成别的字体）。
 */
export const loadPreviewFamily = async (
    fontId: string,
    style: string,
    sample: string,
): Promise<string | null> => {
    const family = `zsft-preview-${fontId}-${style}`;
    if (injectedSheets.has(family)) return family;

    const font = await fetchFont(fontId, style);
    if (!font) return null;

    const picked = slicesCovering(font.slices, codePointsOf(sample) || codePointsOf('字'));
    /*
     * 一个分片都没命中，说明 unicode-range 没解析出来、或者这款字体确实没有这些字。
     * 交给调用方去显示占位，别硬塞一个会落到系统字体上的 family。
     */
    if (picked.length === 0) return null;

    injectSheet(family, sheetFor(family, picked));
    await awaitFamily(family, sample || '字');
    return family;
};

/**
 * 正式使用某款字体：把**全部分片**登记进页面。
 *
 * 与预览不同，正文随时会出现任何字，所以这里把整份样式表交给浏览器，由它按
 * unicode-range 在真正需要时才去下载对应分片 —— 这正是这套 CDN 的设计。
 */
export const loadFullFamily = async (
    fontId: string,
    style: string,
    sample = '字',
): Promise<string | null> => {
    const family = `zsft-full-${fontId}-${style}`;
    if (injectedSheets.has(family)) return family;

    const font = await fetchFont(fontId, style);
    if (!font) return null;

    injectSheet(family, sheetFor(family, font.slices));
    await awaitFamily(family, sample);
    return family;
};

/**
 * 冷启动恢复用户选的字体，并把**常用字**的分片先唤醒。
 *
 * 只 await 一个「字」不够：`document.fonts.load(text)` 只唤醒 `text` 里那些字命中的分片，
 * 其他字在首帧仍会画成回退字体。canvas 样式（fume / cadenza / diorama …）大多没有订阅
 * `document.fonts.ready` 重绘，所以首帧画错的字会一直错下去。这里用一段覆盖常见
 * 汉字与拉丁的样本把主要分片预热掉。
 */
const WARMUP_SAMPLE = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞永风起时花落无声AaBb';

export const warmMarketFontFamily = async (fontId: string): Promise<string | null> => (
    loadFullFamily(fontId, DEFAULT_STYLE, WARMUP_SAMPLE)
);

/** 记住用过哪几个 family，方便「卸载」时把样式表一起摘掉。 */
export const forgetInjectedFamily = (family: string): void => {
    if (!injectedSheets.delete(family) || typeof document === 'undefined') return;
    document.querySelectorAll(`style[data-folia-font="${family}"]`).forEach((node) => node.remove());
};

export const DEFAULT_STYLE = 'main';
