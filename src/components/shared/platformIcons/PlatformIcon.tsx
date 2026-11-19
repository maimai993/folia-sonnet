import React from 'react';
import { findPlatformIcon } from './registry';
import fallbackArt from './fallbackIcon';
import { PLATFORM_ICON_CANVAS, platformIconShell, type PlatformIconArt } from './platformIconShapes';

// src/components/shared/platformIcons/PlatformIcon.tsx
// 平台图标的唯一入口：调用方只写 <PlatformIcon platformId="…" size={…} />，不认具体是哪个文件、
// 也不认是位图还是矢量。没登记的平台画兜底图标。
//
// 这一轮**还没有任何调用方**（业务代码仍在用 src/assets/providers/appIcons.ts 的官方位图）。
// 接通时按 PR 正文的清单逐个替换，替换完这个入口就是唯一画平台图标的地方。

type PlatformIconProps = {
    /** 平台 id（`src/services/onlineMusic/providerRegistry.ts` 登记的那个）。 */
    platformId: string | null | undefined;
    /** 边长，像素。要覆盖 16 / 24 / 32 / 48 四种。 */
    size: number;
    /** 圆形裁切（账号头像、平台记号那一圈都要求圆形）。默认方形圆角底板。 */
    round?: boolean;
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

export const PlatformIcon: React.FC<PlatformIconProps> = ({ platformId, size, round, className, label }) => {
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
            // 内容字符串只来自本目录的静态文件，不含任何外部输入。
            dangerouslySetInnerHTML={{ __html: platformIconShell(art) }}
        />
    );
};

export default PlatformIcon;
