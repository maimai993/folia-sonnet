// src/components/shared/platformIcons/appleMusicIcon.tsx
// Apple Music 的**自绘**占位图标：一颗通用八分音符放进圆底，取玫红这一个识别色相。
// 这是自绘图形，不是官方 logo：官方是「红色圆角方 + 白色双音符」，这里只有一颗单音符、
// 圆角与描边按本目录的统一网格。

import type { PlatformIconArt } from './platformIconShapes';

// Apple Music：玫红。识别线索是「一个音符」。
const art: PlatformIconArt = {
    background: '#FA243C',
    description: '自绘占位图：玫红底 + 白色单颗八分音符（符头、符杆、符尾）',
    content: [
        '<circle cx="20" cy="31" r="5" fill="#FFFFFF"/>',
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<path d="M25 31V17l7.5-1.8V28"/>',
        '</g>',
        '<circle cx="32.5" cy="28" r="3.2" fill="#FFFFFF"/>',
    ].join(''),
};

export default art;
