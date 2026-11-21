// src/components/shared/platformIcons/registry.ts
// 平台图标与平台之间的**唯一**对应表。想给某个平台换图标、加一个平台，都只改这个文件：
// 加一行、或加一个 `<平台>Icon.tsx` 文件再在这里登记。
//
// 每个平台的图形是自己用 SVG 原语画的（见各 `<平台>Icon.tsx` 的文件头），不含任何官方素材；
// 项目里的第三方平台位图已经全部删掉（issue #451），调用方一律画 `<PlatformIcon>`。
// 安卓播放通知栏的角标也从这张表转出来：`androidBadge` 是 `res/drawable/ic_provider_*.xml` 的
// 文件名，由 `npm run build:provider-badges` 生成，所以「哪个平台在通知栏画什么」只有这一处。
//
// 这个文件会点名每个平台，所以它和不认识平台的通用代码要分开看：平台名只在这一处出现。

import { PLATFORM_IDS, type PlatformIconId } from './platformIds';
import type { PlatformIconArt } from './platformIconShapes';
import neteaseIcon from './neteaseIcon';
import qqIcon from './qqIcon';
import wechatIcon from './wechatIcon';
import kugouIcon from './kugouIcon';
import bodianIcon from './bodianIcon';
import qishuiIcon from './qishuiIcon';
import bilibiliIcon from './bilibiliIcon';
import spotifyIcon from './spotifyIcon';
import ytmIcon from './ytmIcon';
import appleMusicIcon from './appleMusicIcon';
import feiniuIcon from './feiniuIcon';
import lxmusicIcon from './lxmusicIcon';

/** 一个平台图标在表里的样子。 */
export interface PlatformIconEntry {
    /** 自绘图形。**不是**官方 logo，见各 `<平台>Icon.tsx` 的文件头。 */
    art: PlatformIconArt;
    /**
     * 安卓播放通知栏角标的资源名（`res/drawable/<名字>.xml`，不带 `ic_provider_` 前缀）。
     *
     * 给了就由 `npm run build:provider-badges` 生成那份 VectorDrawable：它是这颗图形去掉底板
     * 之后的纯白剪影。没给 = 通知栏回落到 Folia 本尊的图标（桌面端才有的平台就是这种）。
     * 名字必须与 `FoliaPlaybackService.providerIconRes()` 认的那一串一致，
     * `test/unit/platformIcons/providerBadges.test.ts` 会核对两边的集合。
     */
    androidBadge?: string;
}

/**
 * 平台 id → 图标。没登记的平台由 PlatformIcon.tsx 回落到 fallbackIcon。
 *
 * 例外条款（issue #430 的备注）：某个平台若在其官方品牌资源页面明确允许使用官方素材，
 * 在那个平台的条目里写明出处并保留官方文件，不放进这张自绘表。
 */
const ICONS_BY_ID: Record<PlatformIconId, PlatformIconEntry> = {
    [PLATFORM_IDS.netease]: { art: neteaseIcon, androidBadge: 'netease' },
    [PLATFORM_IDS.qq]: { art: qqIcon, androidBadge: 'qq' },
    [PLATFORM_IDS.kugou]: { art: kugouIcon, androidBadge: 'kugou' },
    [PLATFORM_IDS.bodian]: { art: bodianIcon, androidBadge: 'bodian' },
    // 汽水音乐在桌面端才跑得起来，但通知栏角标仍留一份，保持全量接入。
    [PLATFORM_IDS.qishui]: { art: qishuiIcon, androidBadge: 'qishui' },
    [PLATFORM_IDS.bilibili]: { art: bilibiliIcon, androidBadge: 'bilibili' },
    // Spotify 与 YouTube Music 的通知由它们自己的播放栈接管，Folia 这边不出通知角标。
    [PLATFORM_IDS.spotify]: { art: spotifyIcon },
    [PLATFORM_IDS.ytm]: { art: ytmIcon },
    [PLATFORM_IDS.appleMusic]: { art: appleMusicIcon, androidBadge: 'applemusic' },
    [PLATFORM_IDS.feiniu]: { art: feiniuIcon, androidBadge: 'feiniu' },
    // 洛雪音源（免登录）：通知栏也画它自己那一颗。
    [PLATFORM_IDS.lxmusic]: { art: lxmusicIcon, androidBadge: 'lxmusic' },
};

/**
 * 同一张表的另一种读法：带 id 一条条列出来。
 *
 * 生成器（`scripts/buildProviderBadges.mjs`）和用例要的是「一条一条」，不是按 id 查。顺序照登记的
 * 顺序。两种读法都从这里出发，所以「通知栏画哪几家」和「界面画哪几家」不会各说一套。
 */
export const PLATFORM_ICONS: ReadonlyArray<{ id: PlatformIconId } & PlatformIconEntry> = (
    Object.entries(ICONS_BY_ID) as Array<[PlatformIconId, PlatformIconEntry]>
).map(([id, entry]) => ({ id, ...entry }));

/** 拿一个平台的图标条目；没登记的回 null（由调用方决定怎么兜底）。 */
export const findPlatformIcon = (platformId: string | null | undefined): PlatformIconEntry | null => (
    (platformId && Object.hasOwn(ICONS_BY_ID, platformId))
        ? ICONS_BY_ID[platformId as PlatformIconId]
        : null
);

/**
 * 登录方式用的图标：**不是平台**的那种（同一个平台后端下面另开一条通道的方式）。
 *
 * 它们没有自己的平台目录，也就不会进 `ICONS_BY_ID`（那张表是「平台 id → 平台图标」）；但登录窗口
 * 的登录方式按钮要画它们。名字照平台 adapter 声明的 `LoginMethod.iconKey` 取，`loginMethodIcon`
 * 先查这张表、再回落平台表。
 */
const LOGIN_METHOD_ICONS: Record<string, PlatformIconArt> = {
    wechat: wechatIcon,
};

/** 登录方式的名字 → 图形；不认的名字回 null。 */
export const findLoginMethodIcon = (iconKey: string | null | undefined): PlatformIconArt | null => (
    (iconKey && Object.hasOwn(LOGIN_METHOD_ICONS, iconKey)) ? LOGIN_METHOD_ICONS[iconKey] : null
);

/** 这个 id 有没有登记过图形（调用方据此决定画图形还是画「字 + 颜色」）。 */
export const hasPlatformIcon = (platformId: string | null | undefined): boolean => findPlatformIcon(platformId) !== null;
