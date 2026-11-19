// src/components/shared/platformIcons/registry.ts
// 平台图标与平台之间的**唯一**对应表。想给某个平台换图标、加一个平台，都只改这个文件：
// 加一行、或加一个 `<平台>Icon.tsx` 文件再在这里登记。
//
// 图标进化的三个阶段（issue #430）：
//   1. 画完：本文件里的一行从 `status: 'placeholder'` 改成 `'final'`。
//   2. 接上：调用方不再用 src/assets/providers/appIcons.ts 的位图，改画 <PlatformIcon>。
//   3. 收尾：官方素材与其登记表一起删掉（见 PR 正文的「下一步」）。
//
// 这个文件会点名每个平台，所以它和不认识平台的通用代码要分开看：平台名只在这一处出现。

import { PLATFORM_IDS, type PlatformIconId } from './platformIds';
import type { PlatformIconArt } from './platformIconShapes';
import neteaseIcon from './neteaseIcon';
import qqIcon from './qqIcon';
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
    /** 自绘图形。**不是**官方 logo，见各 <平台>Icon.tsx 的文件头。 */
    art: PlatformIconArt;
    /**
     * placeholder：只是占位图形，等着画成正式的一套；
     * final：已经定稿，可以直接替换官方素材。
     * 这一轮（第一轮）全部是 placeholder。
     */
    status: 'placeholder' | 'final';
    /** 这一轮还没做完时写在这里：还差什么、谁能例外。 */
    note?: string;
}

/**
 * 平台 id → 图标。没登记的平台由 PlatformIcon.tsx 回落到 fallbackIcon。
 *
 * 例外条款（issue #430 的备注）：某个平台若在其官方品牌资源页面明确允许使用官方素材，
 * 在那个平台的条目里加 `note` 写明出处并保留官方文件，不放进这张自绘表。
 */
export const PLATFORM_ICONS: Record<PlatformIconId, PlatformIconEntry> = {
    [PLATFORM_IDS.netease]: { art: neteaseIcon, status: 'placeholder' },
    [PLATFORM_IDS.qq]: { art: qqIcon, status: 'placeholder' },
    [PLATFORM_IDS.kugou]: { art: kugouIcon, status: 'placeholder' },
    [PLATFORM_IDS.bodian]: { art: bodianIcon, status: 'placeholder' },
    [PLATFORM_IDS.qishui]: { art: qishuiIcon, status: 'placeholder' },
    [PLATFORM_IDS.bilibili]: {
        art: bilibiliIcon,
        status: 'placeholder',
        note: '现用的 bilibili.svg 是官方电视造型的矢量复刻，替换价值最高',
    },
    [PLATFORM_IDS.spotify]: { art: spotifyIcon, status: 'placeholder' },
    [PLATFORM_IDS.ytm]: { art: ytmIcon, status: 'placeholder' },
    [PLATFORM_IDS.appleMusic]: { art: appleMusicIcon, status: 'placeholder' },
    [PLATFORM_IDS.feiniu]: { art: feiniuIcon, status: 'placeholder' },
    [PLATFORM_IDS.lxmusic]: { art: lxmusicIcon, status: 'placeholder' },
};

/** 拿一个平台的图标条目；没登记的回 null（由调用方决定怎么兜底）。 */
export const findPlatformIcon = (platformId: string | null | undefined): PlatformIconEntry | null => (
    (platformId && Object.hasOwn(PLATFORM_ICONS, platformId))
        ? PLATFORM_ICONS[platformId as PlatformIconId]
        : null
);
