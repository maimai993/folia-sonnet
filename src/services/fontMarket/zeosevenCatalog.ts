import catalog from './zeosevenCatalog.json';

// src/services/fontMarket/zeosevenCatalog.ts
//
// ZeoSeven Fonts（ZSFT）的字体目录。
//
// 为什么要内置这份清单：zsft 的浏览页是静态导出（nextExport），1357 款字体的目录**直接
// 打包在那个 route chunk 里**，没有 JSON 接口可拉。所以这里把目录烘成 JSON 一起发版，
// 由 tools/extract-zeoseven-catalog.mjs 生成（站点改版后重跑一次即可）。
//
// 字体本身不在这里：它们是按 unicode-range 切成几百个小 woff2 的 WebFont，
// 地址在运行时才拼（见 zeosevenFont.ts）。这样正文只需要下载命中的那几个分片。

export interface ZeosevenFont {
    /** FontsAPI 的字体 ID：`/<id>/<style>/result.css`。 */
    id: string;
    name: string;
    alias: string;
    designer: string;
    license: string;
    /** ISO 语种子集标记（cn / tw / jp / kr / en …）。 */
    languages: string[];
    /** 风格标记（serif / sans / round / kai / pixel / display …）。 */
    styles: string[];
    /** 字重数量。 */
    weights: number;
}

export const ZEOSEVEN_FONTS: readonly ZeosevenFont[] = (catalog as ZeosevenFont[])
    .filter((font) => Boolean(font?.id && font?.name));

const BY_ID = new Map(ZEOSEVEN_FONTS.map((font) => [font.id, font]));

export const getZeosevenFont = (id: string): ZeosevenFont | undefined => BY_ID.get(id);

/*
 * 风格与语种的中文名。官网自己的筛选面板就用这些词，这里对齐，免得两边叫法不一样。
 * 认不出的标记原样显示 —— 站点新加一类风格时，界面不会因此变空。
 */
const STYLE_LABELS: Record<string, string> = {
    serif: '衬线',
    sans: '无衬线',
    script: '手写',
    mono: '等宽',
    display: '展示',
    round: '圆体',
    pixel: '像素',
    creative: '创意',
    kai: '楷书',
    mao: '毛笔',
    zhuan: '篆书',
    xing: '行书',
    cao: '草书',
    pinyin: '附带拼音',
    li: '隶书',
    oracle: '甲骨文',
    cy: '仿 Cyrillic',
    unknown: '未知风格',
};

const LANGUAGE_LABELS: Record<string, string> = {
    cn: '简体中文',
    tw: '繁体中文',
    jp: '日文',
    kr: '谚文',
    en: '拉丁字母',
    ew: '西里尔字母',
    xl: '希腊文',
    icon: '图标',
    nu: '女书',
    tibetan: '藏文',
    yi: '彝文',
    thai: '泰文',
    ryu: '琉球',
    arabic: '阿拉伯字母',
    mongolian: '蒙古文',
    burmese: '缅甸文',
    khmer: '高棉文',
    tangut: '契丹小字',
    hieroglyph: '埃及圣书体',
    runic: '卢恩符文',
    hebrew: '希伯来文',
    jia: '甲骨文',
    nvzhen: '女真文',
};

export const styleLabel = (style: string): string => STYLE_LABELS[style] ?? style;

export const languageLabel = (language: string): string => LANGUAGE_LABELS[language] ?? language;

/** 目录里出现过的全部风格，按出现顺序去重 —— 用来生成筛选页签。 */
export const listZeosevenStyles = (): string[] => {
    const seen = new Set<string>();
    for (const font of ZEOSEVEN_FONTS) {
        for (const style of font.styles) seen.add(style);
    }
    return [...seen];
};
