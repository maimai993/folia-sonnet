import neteaseIcon from './netease.png';
import qqMusicIcon from './qqmusic.png';
import kugouIcon from './kugou.png';
import bodianIcon from './bodian.jpg';
import foliaIcon from './folia.svg';

// src/assets/providers/appIcons.ts
// 各在线音乐平台「应用本尊」的图标。登录界面、通知栏角标这些地方要的是"这首歌来自哪个
// 平台"的那颗 App 图标，而不是 provider 的 logo 字 —— 图标文件放这里，映射也放这里，
// 谁要用谁 import，别在组件里各自写一份 providerId → 文件的对照表。

/**
 * providerId → 图标模块。
 *
 * 本地音乐、Navidrome、以及将来任何没图的平台都回落到 Folia 自己的图标（见 getProviderAppIcon），
 * 所以表里只放确有本尊图的四家。
 */
export const PROVIDER_APP_ICONS: Record<string, string> = {
    netease: neteaseIcon,
    qq: qqMusicIcon,
    kugou: kugouIcon,
    bodian: bodianIcon,
};

/** 本地曲库等"自家人"来源统一用的图标 key。 */
export const FOLIA_ICON_KEY = 'folia';

/** 兜底图标：Folia 本尊。 */
export const FOLIA_APP_ICON = foliaIcon;

/** 拿平台的应用图标；没登记的（含空值）一律回落 Folia 图标，调用方不必判空。 */
export const getProviderAppIcon = (providerId: string | null | undefined): string => (
    (providerId && PROVIDER_APP_ICONS[providerId]) || foliaIcon
);
