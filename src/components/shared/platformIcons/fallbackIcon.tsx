// src/components/shared/platformIcons/fallbackIcon.tsx
// 兜底图标：没登记的来源（本地曲库、mod 加进来的平台、将来的新平台）一律用它。
// 和 Folia 本尊的图标一样是**自绘**的：一个中性的几何记号，不指向任何第三方。

import type { PlatformIconArt } from './platformIconShapes';

// 中性灰：不带识别色相，一看就知道「这个来源没有专属图标」。
const art: PlatformIconArt = {
    background: '#5D5D66',
    description: '自绘占位图：中性灰底 + 一个同心圆记号（兜底）',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round">',
        '<circle cx="24" cy="24" r="10"/>',
        '<path d="M24 16v16"/><path d="M16 24h16"/>',
        '</g>',
    ].join(''),
};

export default art;
