// src/components/shared/platformIcons/ytmIcon.tsx
// YouTube Music 的**自绘**占位图标：一个红圆里放播放三角，再叠一小段「声波条」。
// 这是自绘图形，不是官方 logo：官方是纯白底 + 一个大红圆，这里改成红底白线的圆盘 + 三道竖条，
// 三角也缩小、挪到中心偏左。

import type { PlatformIconArt } from './platformIconShapes';

// YouTube Music：红。识别线索是「播放」——圆盘里一个三角，旁边三道高矮不一的竖条。
const art: PlatformIconArt = {
    background: '#E11D48',
    description: '自绘占位图：红底 + 白色圆盘里的播放三角与三道音轨条',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<circle cx="21" cy="24" r="8"/>',
        '<path d="M19 20.5v7l6-3.5z" fill="#FFFFFF"/>',
        '<path d="M33 21v6"/><path d="M36.5 18v12"/>',
        '</g>',
    ].join(''),
};

export default art;
