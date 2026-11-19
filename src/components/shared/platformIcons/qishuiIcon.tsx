// src/components/shared/platformIcons/qishuiIcon.tsx
// 汽水的**自绘**图标：一个简单的气泡（「汽」）里放一个播放三角。
// 这是自绘图形，不是官方 logo：官方那颗带斜切的渐变音符一概不复刻，配色也还原到偏青的绿。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';

// 汽水：青绿。识别线索是「汽泡 / 播放」——圆气泡加一个朝右的三角。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M13.5 24a10.5 10.5 0 1 0 21 0a10.5 10.5 0 1 0-21 0' },
    { kind: 'stroke', d: 'M20.3 17.9L26.9 24L20.3 30.1Z', fill: W, stroke: { color: W, width: 2 } },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#19A58C',
    description: '自绘占位图：青绿底 + 白色圆形气泡里一个播放三角',
});

export default art;
