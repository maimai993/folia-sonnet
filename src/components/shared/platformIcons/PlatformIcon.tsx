import React from 'react';
import { findPlatformIcon } from './registry';
import fallbackArt from './fallbackIcon';
import { PLATFORM_ICON_CANVAS, platformIconShell, type PlatformIconArt } from './platformIconShapes';

// src/components/shared/platformIcons/PlatformIcon.tsx
// 平台图标的唯一出口：调用方只写 <PlatformIcon platformId="…" size={…} />，不认具体是哪个文件、
// 也不认是位图还是矢量。没登记的平台画兜底图标（`fallbackIcon`）。
//
// 登录窗口、主页的登录按钮、账号切换器、资料库的平台徽章、Bravais 的头像、安卓播放通知栏的
// 角标都从这里取；项目里已经没有第三方平台的位图文件（见 issue #451）。

type PlatformIconProps = {
    /** 平台 id（`src/services/onlineMusic/providerRegistry.ts` 登记的那个）。 */
    platformId: string | null | undefined;
    /** 边长，像素。要覆盖 16 / 24 / 32 / 48 四种。 */
    size: number;
    /** 圆形裁切（账号头像、平台记号那一圈都要求圆形）。默认方形圆角底板。 */
    round?: boolean;
    /**
     * 画成字母徽章的底色：给了就不画图形，圆底上只写首字（登记过的平台干脆留空）。
     *
     * 主页登录按钮、切换器这些地方的徽章一直是「字 + 色」，位子又只有一两行高，
     * 图形在 16px 上分不出谁是谁；要图形的调用方不传这一项，直接画自绘图形。
     */
    badge?: { letter: string; color: string; onColor: string };
    className?: string;
    /**
     * 给屏幕阅读器念的名字。不给就整颗图标当装饰（aria-hidden）；
     * 旁边已经有平台名的调用方不要给。
     */
    label?: string;
};

/** 图标内部的内容；图是 SVG 原语拼的字符串，所以用 dangerouslySetInnerHTML。 */
const iconArt = (platformId: string | null | undefined): PlatformIconArt => (
    findPlatformIcon(platformId)?.art ?? fallbackArt
);

/** 没登记的平台画成字母徽章时用的圆底（`badge` 没给颜色时的中性灰）。 */
const BADGE_FALLBACK = { color: '#5D5D66', onColor: '#FFFFFF' } as const;

/*
 * 尺寸只认 size 这一个数。
 *
 * 调用方常常顺手带上 `className="h-full w-full"` 想把图标填满它所在的框（平台记号、头像、切换器
 * 都是这么写的）。但 SVG 的 width/height 是属性，`h-full`/`w-full` 是 CSS，CSS 赢 —— 于是 16px
 * 的那一颗在框里被拉成 32px，四档尺寸全被抹平。这里把尺寸写成行内样式，行内样式排在 class 之后，
 * `h-full`/`w-full` 就压不住它了（真要换尺寸，传 size）。
 */
const BOX = (size: number): React.CSSProperties => ({ width: size, height: size, flex: 'none' });

export const PlatformIcon: React.FC<PlatformIconProps> = ({ platformId, size, round, badge, className, label }) => {
    if (badge) {
        const letter = Array.from(badge.letter.trim())[0] ?? '?';
        // 有自绘图形的平台不画字；没登记的（mod 加进来的平台、空值）才把它的首字写在圆底上。
        const glyph = findPlatformIcon(platformId) ? null : letter;
        return (
            <span
                role={label ? 'img' : undefined}
                aria-label={label}
                aria-hidden={label ? undefined : true}
                className={`inline-grid shrink-0 place-items-center rounded-full font-bold leading-none ${className ?? ''}`}
                style={{
                    ...BOX(size),
                    background: badge.color || BADGE_FALLBACK.color,
                    color: badge.onColor || BADGE_FALLBACK.onColor,
                    fontSize: Math.round(size * 0.42),
                }}
            >
                {glyph}
            </span>
        );
    }
    const art = iconArt(platformId);
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${PLATFORM_ICON_CANVAS} ${PLATFORM_ICON_CANVAS}`}
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
            focusable="false"
            className={`${round ? 'rounded-full' : ''} ${className ?? ''}`}
            style={BOX(size)}
            // 内容字符串只来自本目录的静态文件，不含任何外部输入。
            dangerouslySetInnerHTML={{ __html: platformIconShell(art) }}
        />
    );
};

export default PlatformIcon;
