// src/library/suites/rhine/rhineHostConfig.ts
//
// 「莱茵生命」主题骨架（`res/rhine-theme/`）与宿主之间的配置：一份数据、两个去处。
//
// 主题那边两种收法都要支持 —— 首次加载时走 URL 参数（那时候还没有窗口能听 postMessage），
// 之后换语言 / 明暗 / 资源包就绪时走 postMessage。两条路必须产生同一份内容，所以拼装只在这里
// 写一次，`RhineHome` 只负责调用。
//
// 字段的权威定义在 `res/rhine-theme/adapt/rhineHostConfig.js`；这里改字段要同时改那份、以及
// `res/rhine-theme/RHINE-ASSETS.md` 的「接口」一节。

/**
 * 安全区（逻辑像素）。
 *
 * 安卓 WebView 里 `env(safe-area-inset-*)` 基本报 0，iframe 里更拿不到宿主的
 * `--folia-safe-area-*`，真实值由原生侧算好（`services/phoneInsets`）再送进来。
 */
export type RhineInsets = {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
};

export type RhineHostConfigInput = {
    /** 界面语言（BCP 47）。 */
    language: string;
    /** Folia 的明暗设置。 */
    isDaylight: boolean;
    /** 资源包在本地（#440 接上之前恒为 false）。 */
    hasAssetsPackage: boolean;
    /** 宿主按 i18n 给的说明文案：资源包缺失时显示在舞台底部。 */
    note: string;
    insets: RhineInsets;
};

/** 推给主题的配置对象（与 `window.FOLIA_RHINE` 同名同形）。 */
export type RhineHostConfig = {
    language: string;
    theme: 'light' | 'dark';
    assets: 'downloaded' | 'bundled';
    hasAssetsPackage: boolean;
    note: string;
    insets: RhineInsets;
};

/** 骨架页面相对站点根的路径；构建产物里它也在这。 */
export const RHINE_FRAME_PAGE = 'res/rhine-theme/index.html';

const themeOf = (isDaylight: boolean): 'light' | 'dark' => (isDaylight ? 'light' : 'dark');

export const buildRhineHostConfig = (input: RhineHostConfigInput): RhineHostConfig => ({
    language: input.language,
    theme: themeOf(input.isDaylight),
    assets: input.hasAssetsPackage ? 'downloaded' : 'bundled',
    hasAssetsPackage: input.hasAssetsPackage,
    note: input.note,
    insets: input.insets,
});

/**
 * iframe 的 src：把同一份配置写成查询参数。
 *
 * `base` 缺省用 `import.meta.env.BASE_URL`（桌面 / 安卓是 `./`，网页版是 `/`），补上尾斜杠再拼
 * 路径 —— 少一个斜杠就会解析到上一级目录去，主题页面直接 404。
 */
export const buildRhineFrameSrc = (
    input: RhineHostConfigInput,
    base: string = import.meta.env.BASE_URL,
): string => {
    const config = buildRhineHostConfig(input);
    const params = new URLSearchParams({
        lang: config.language,
        theme: config.theme,
        assets: config.hasAssetsPackage ? '1' : '0',
    });
    if (config.note) params.set('note', config.note);
    const root = base.endsWith('/') ? base : `${base}/`;
    return `${root}${RHINE_FRAME_PAGE}?${params.toString()}`;
};
