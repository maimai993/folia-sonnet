// src/components/login/loginMethodIcons.tsx
// 登录方式的图标。平台只声明图标的名字（LoginMethod.iconKey），这里按名字找对应的自绘图形：
// 先看 platformIcons/registry 里「登录方式自己的图形」（同一个后端下面另开一条通道的那种方式），
// 再按平台 id 找平台图形。
//
// 项目里已经没有任何第三方平台位图（issue #451），所以不再有「往文件夹里放一张图」这条捷径：
// 图标一律是自绘的 SVG，按名字现画。`iconKey` 为空（不需要图标的方式）或找不到对应图形时给
// undefined，画面上就没有图标。
//
// 这里**不许点名任何平台**：登录窗口的目录要与平台无关（见 loginModuleKnowsNoPlatform
// 那条守卫），平台自己的东西由它自己的 adapter 通过 omni 声明、由 registry 登记。
//
// 是 .tsx 不是 .ts：这里要写 JSX（画 <PlatformIcon>）。

import type React from 'react';
import { findLoginMethodIcon, findPlatformIcon } from '../shared/platformIcons/registry';
import { PlatformIcon } from '../shared/platformIcons/PlatformIcon';
import { PLATFORM_ICON_CANVAS, platformIconShell } from '../shared/platformIcons/platformIconShapes';

/**
 * 登录方式的 `iconKey` → 平台 id。
 *
 * 平台声明的名字不一定就是登记的平台 id：同一个后端通道可能换个后缀叫（`x` / `xmusic`），
 * 而两者是同一家。这里只做与平台无关的归一 —— 去掉音乐类后缀再试一次 —— 不做别的猜测。
 */
const iconPlatformId = (iconKey: string): string | null => {
    if (!iconKey) return null;
    if (findPlatformIcon(iconKey)) return iconKey;
    const stem = iconKey.replace(/(music|app|web|h5|mobile)$/i, '');
    if (stem !== iconKey && findPlatformIcon(stem)) return stem;
    return null;
};

/** 登录方式的图标（16px 的那一枚）；没有可画的图形时给 undefined，调用方不画。 */
export const loginMethodIcon = (iconKey: string): React.ReactNode => {
    const art = findLoginMethodIcon(iconKey);
    if (art) {
        return (
            <svg
                width={16}
                height={16}
                viewBox={`0 0 ${PLATFORM_ICON_CANVAS} ${PLATFORM_ICON_CANVAS}`}
                aria-hidden
                focusable="false"
                className="h-4 w-4 rounded-full"
                // 内容字符串只来自本目录的静态几何，不含任何外部输入。
                dangerouslySetInnerHTML={{ __html: platformIconShell(art) }}
            />
        );
    }
    const platformId = iconPlatformId(iconKey);
    return platformId ? <PlatformIcon platformId={platformId} size={16} round className="h-4 w-4" /> : undefined;
};
