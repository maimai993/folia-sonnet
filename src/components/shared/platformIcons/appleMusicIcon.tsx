// src/components/shared/platformIcons/appleMusicIcon.tsx
// Apple Music 的**自绘**图标：一颗通用八分音符放进圆底，取玫红这一个识别色相。
// 这是自绘图形，不是官方 logo：官方是「红色圆角方 + 白色双音符」，这里只有一颗单音符、
// 圆角与描边按本目录的统一网格。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';
const dot = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

// Apple Music：玫红。识别线索是「一个音符」——大符头 + 符杆 + 符尾收的一颗小符头。
const gestures: PlatformIconGesture[] = [
    { kind: 'stroke', d: dot(19.8, 30.4, 5), fill: W },
    { kind: 'stroke', d: dot(32.4, 27.4, 3.4), fill: W },
    { kind: 'outline', d: 'M24.8 30.4V17.6L34.5 15.4V24.6' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#FA243C',
    description: '自绘占位图：玫红底 + 白色单颗八分音符（符头、符杆、符尾）',
});

export default art;
