// src/components/shared/platformIcons/bodianIcon.tsx
// 波点的**自绘**图标：一排高低不同的「点」连成波形，取青绿这一个识别色相。
// 这是自绘图形，不是官方 logo：官方那种「小写 b + 播放三角 + 角上一颗唱机」一个都不复刻。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。这一家只有实心圆点，所以内容全是 `stroke`。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';
const dot = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

// 波点：青。识别线索是「点」——六个圆点排成一道起伏的波形。
const gestures: PlatformIconGesture[] = [
    { kind: 'stroke', d: dot(14, 26, 3), fill: W },
    { kind: 'stroke', d: dot(20, 20, 3), fill: W },
    { kind: 'stroke', d: dot(26, 27, 3), fill: W },
    { kind: 'stroke', d: dot(32, 19, 3), fill: W },
    { kind: 'stroke', d: dot(24, 33, 2.2), fill: W },
    { kind: 'stroke', d: dot(34, 30, 2.2), fill: W },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#0D9488',
    description: '自绘占位图：青底 + 白色圆点排成的波形',
});

export default art;
