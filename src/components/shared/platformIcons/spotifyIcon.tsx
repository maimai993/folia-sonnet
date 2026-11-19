// src/components/shared/platformIcons/spotifyIcon.tsx
// Spotify 的**自绘**图标：三道「声波弧」平放成一组，取 Spotify 的绿。
// 这是自绘图形，不是官方 logo：官方是「绿圆 + 三道黑色弧线」的整体构造，这里换成方底板 +
// 白色线稿，弧的曲率与间距都按本目录的统一网格重画。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。这一家只有线，所以内容全是 `outline`。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';

// Spotify：绿。识别线索是「几道平行的弧」。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M14 20c7-3 14-2.6 20 1' },
    { kind: 'outline', d: 'M15.5 27c5.5-2.4 11-2 15.5 1' },
    { kind: 'outline', d: 'M17.5 33.4c3.6-1.6 7.2-1.3 10.2 0.6' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#1DB954',
    description: '自绘占位图：绿底 + 白色三道平行的声波弧',
});

export default art;
