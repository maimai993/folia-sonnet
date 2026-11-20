// src/components/shared/platformIcons/kugouIcon.tsx
// 酷狗的**自绘**图标：一枚「唱片 + 声波」的圆形徽记，取酷狗的蓝色。
// 这是自绘图形，不是官方 logo：官方那种「蓝底 + 白圈 + K」的构造一个都不复刻。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';

// 酷狗：蓝。识别线索是「圆盘」——外圈 + 中心轴 + 旁边两道越来越长的声波弧。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M13 24a8 8 0 1 0 16 0a8 8 0 1 0-16 0' },
    { kind: 'stroke', d: 'M18.6 24a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0-4.8 0', fill: W },
    { kind: 'outline', d: 'M33 17a10 10 0 0 1 0 14' },
    { kind: 'outline', d: 'M36.5 13.5a15 15 0 0 1 0 21' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#2563EB',
    description: '自绘占位图：蓝底 + 白色圆盘徽记（外圈 + 中心轴）与两道声波弧',
});

export default art;
