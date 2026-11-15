// src/services/backgroundMarket/types.ts
//
// 背景市场的公共类型。
//
// 三个源的结构差别很大（Moewalls 是 WordPress 视频站、haowallpaper 是 Nuxt 的混合站、
// bizhihui 是图片站），但界面只该看到同一套字段，所以这里定义统一的形状，
// 各源自己负责把差异吃掉。

export type BackgroundMarketKind = 'video' | 'image';

export interface BackgroundMarketItem {
    /** 全局唯一：`<source>:<源内 id>`，用来做列表 key 与「正在下载」标记。 */
    id: string;
    source: BackgroundMarketSourceId;
    sourceLabel: string;
    name: string;
    kind: BackgroundMarketKind;
    /** 列表缩略图，直接可 <img src>。 */
    thumbnailUrl: string;
    /** 详情页地址，用于「去官网看」。 */
    detailUrl: string;
    width?: number;
    height?: number;
    /**
     * 拿真实文件的地址。
     *
     * 视频源（Moewalls）这里可能为空：它的高清地址要再进详情页换一次，
     * 见 resolveBackgroundMediaUrl。
     */
    mediaUrl?: string;
    /** 拿媒体地址时的额外请求头（有的站查 Referer）。 */
    mediaHeaders?: Record<string, string>;
}

export type BackgroundMarketSourceId = 'moewalls' | 'haowallpaper' | 'bizhihui';

export interface BackgroundMarketSource {
    id: BackgroundMarketSourceId;
    label: string;
    /** 这个源只出什么类型 —— 界面据此提示「这个源只有视频」。 */
    kinds: BackgroundMarketKind[];
    supportsSearch: boolean;
}

export interface BackgroundMarketPage {
    items: BackgroundMarketItem[];
    /** 还有没有下一页。各站没有统一的 total，只能靠「这页拿满了没」推断。 */
    hasMore: boolean;
    page: number;
}

export interface BackgroundMarketQuery {
    source: BackgroundMarketSourceId;
    page: number;
    /** 分类 slug（仅部分源支持）。 */
    category?: string;
    keyword?: string;
}
