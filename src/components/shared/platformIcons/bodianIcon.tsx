// src/components/shared/platformIcons/bodianIcon.tsx
// 波点的**自绘**占位图标：一排高低不同的「点」连成波形，取青绿这一个识别色相。
// 这是自绘图形，不是官方 logo：官方那种「小写 b + 播放三角 + 角上一颗唱机」一个都不复刻。

import type { PlatformIconArt } from './platformIconShapes';

// 波点：青。识别线索是「点」——六个圆点排成一道起伏的波形。
const art: PlatformIconArt = {
    background: '#0D9488',
    description: '自绘占位图：青底 + 白色圆点排成的波形',
    content: [
        '<g fill="#FFFFFF">',
        '<circle cx="14" cy="26" r="3"/><circle cx="20" cy="20" r="3"/>',
        '<circle cx="26" cy="27" r="3"/><circle cx="32" cy="19" r="3"/>',
        '<circle cx="24" cy="33" r="2.2"/><circle cx="34" cy="30" r="2.2"/>',
        '</g>',
    ].join(''),
};

export default art;
