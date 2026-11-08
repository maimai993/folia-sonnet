import neteaseIcon from './netease.png';
import qqMusicIcon from './qqmusic.webp';
import kugouIcon from './kugou.webp';
import bodianIcon from './bodian.webp';
import feiniuIcon from './feiniu.png';
import qishuiIcon from './qishui.png';
import lxmusicIcon from './lxmusic.png';
import spotifyIcon from './spotify.png';
import ytmIcon from './ytm.png';
import appleMusicIcon from './applemusic.png';
import foliaIcon from './folia.svg';

// src/assets/providers/appIcons.ts
// 各在线音乐平台「应用本尊」的图标。登录界面、通知栏角标这些地方要的是"这首歌来自哪个
// 平台"的那颗 App 图标，而不是 provider 的 logo 字 —— 图标文件放这里，映射也放这里，
// 谁要用谁 import，别在组件里各自写一份 providerId → 文件的对照表。

/**
 * providerId → 图标模块。
 *
 * 本地音乐、Navidrome、以及将来任何没图的平台都回落到 Folia 自己的图标（见 getProviderAppIcon），
 * 所以表里只放确有本尊图的几家。
 */
export const PROVIDER_APP_ICONS: Record<string, string> = {
    netease: neteaseIcon,
    qq: qqMusicIcon,
    kugou: kugouIcon,
    bodian: bodianIcon,
    feiniu: feiniuIcon,
    qishui: qishuiIcon,
    // 洛雪音源（免登录）：登录窗口那一行与切换器都亮这颗图标。
    lxmusic: lxmusicIcon,
    // Spotify 与 YouTube Music 只在桌面端（Electron）跑得起来（它们要 `folia-spotify:` /
    // `folia-ytm:` 那种本地协议），但登录窗口那一列平台在两端都画，没图就只剩一个彩色的字。
    spotify: spotifyIcon,
    ytm: ytmIcon,
    // v0.7.27 上游新增的那一家（macOS / Windows 桌面端）：登录窗口那一列与切换器画本尊。
    appleMusic: appleMusicIcon,
};

/** 本地曲库等"自家人"来源统一用的图标 key。 */
export const FOLIA_ICON_KEY = 'folia';

/** 兜底图标：Folia 本尊。 */
export const FOLIA_APP_ICON = foliaIcon;

/** 拿平台的应用图标；没登记的（含空值）一律回落 Folia 图标，调用方不必判空。 */
export const getProviderAppIcon = (providerId: string | null | undefined): string => (
    (providerId && PROVIDER_APP_ICONS[providerId]) || foliaIcon
);
