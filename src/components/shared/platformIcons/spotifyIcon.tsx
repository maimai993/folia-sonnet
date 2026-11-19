// src/components/shared/platformIcons/spotifyIcon.tsx
// Spotify 的**自绘**占位图标：三道「声波弧」平放成一组，取 Spotify 的绿。
// 这是自绘图形，不是官方 logo：官方是「绿圆 + 三道黑色弧线」的整体构造，这里换成方底板 +
// 白色线稿，弧的曲率与间距都按本目录的统一网格重画。

import type { PlatformIconArt } from './platformIconShapes';

// Spotify：绿。识别线索是「几道平行的弧」。
const art: PlatformIconArt = {
    background: '#1DB954',
    description: '自绘占位图：绿底 + 白色三道平行的声波弧',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round">',
        '<path d="M15 18.5c6-2.4 12.5-2 18 .8"/>',
        '<path d="M16.5 24.5c5-2 10.5-1.7 15 .6"/>',
        '<path d="M18 30.5c4-1.6 8.5-1.3 12 .5"/>',
        '</g>',
    ].join(''),
};

export default art;
