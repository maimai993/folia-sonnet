// src/components/shared/platformIcons/platformIds.ts
// 各在线平台在图标表里用的 id 字面量。单独放一份是为了让 registry.ts 不必逐个 import 平台文件
// （平台文件反过来要从这里取自己的 id）。凡是要在本目录里点名平台的文件都从这里取，不另写字面量，
// 这样「平台名出现在哪」仍然只有这一处。

/** 与 `src/services/onlineMusic/providerRegistry.ts` 里登记的平台 id 一一对应。 */
export const PLATFORM_IDS = {
    netease: 'netease',
    qq: 'qq',
    kugou: 'kugou',
    bodian: 'bodian',
    qishui: 'qishui',
    bilibili: 'bilibili',
    spotify: 'spotify',
    ytm: 'ytm',
    appleMusic: 'appleMusic',
    feiniu: 'feiniu',
    lxmusic: 'lxmusic',
} as const;

/** 图标表认得的平台 id（其余的一律回落到中性的兜底图标）。 */
export type PlatformIconId = typeof PLATFORM_IDS[keyof typeof PLATFORM_IDS];
