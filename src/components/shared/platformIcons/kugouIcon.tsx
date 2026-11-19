// src/components/shared/platformIcons/kugouIcon.tsx
// 酷狗的**自绘**占位图标：一枚「唱片 + 声波」的圆形徽记，取酷狗的蓝色。
// 这是自绘图形，不是官方 logo：官方那种「蓝底 + 白圈 + K」的构造一个都不复刻。

import type { PlatformIconArt } from './platformIconShapes';

// 酷狗：蓝。识别线索是「圆盘」——外圈 + 中心轴 + 旁边两道越来越短的声波弧。
const art: PlatformIconArt = {
    background: '#2563EB',
    description: '自绘占位图：蓝底 + 白色圆盘徽记与三道声波弧',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round">',
        '<circle cx="21" cy="24" r="8"/>',
        '<path d="M33 17a10 10 0 0 1 0 14"/>',
        '<path d="M36.5 13.5a15 15 0 0 1 0 21"/>',
        '</g>',
        '<circle cx="21" cy="24" r="2.4" fill="#FFFFFF"/>',
    ].join(''),
};

export default art;
