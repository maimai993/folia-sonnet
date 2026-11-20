// src/components/shared/platformIcons/lxmusicIcon.tsx
// 洛雪音源的**自绘**图标：一段连着的双符头音符 + 一个朝下的箭头（取自它原本的「取回」含义）。
// 这是自绘图形，不是对方图标的复刻：本文件只借「绿色 + 音符 + 取回」这几条最粗的线索重新画。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';
const dot = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

// 洛雪：绿。识别线索是「音符 + 取回」——两个符头一根符杆，下面再收一个箭头。
// 箭头的尾巴与箭头都落在内容框（12..36）里：3 像素的圆头描边会再探出 1.5 像素，仍留得住。
const gestures: PlatformIconGesture[] = [
    { kind: 'stroke', d: dot(17.4, 28.6, 4.2), fill: W },
    { kind: 'stroke', d: dot(29.4, 24.4, 4.2), fill: W },
    { kind: 'outline', d: 'M21.6 28.6V16.8L33.6 12.4V19.6' },
    { kind: 'outline', d: 'M31.2 30.2v3.6' },
    { kind: 'outline', d: 'M27.8 31.4L31.2 34.8l3.4-3.4' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#059669',
    description: '自绘占位图：绿底 + 白色双符头音符加一个朝下的箭头',
});

export default art;
