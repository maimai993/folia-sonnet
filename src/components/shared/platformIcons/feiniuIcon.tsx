// src/components/shared/platformIcons/feiniuIcon.tsx
// 飞牛的**自绘**图标：一个朝上的箭头穿进圆环，取深蓝这一个识别色相。
// 这是自绘图形，不是官方 logo：原来的那张位图是对方自带的深色画布 + 红色圆 + 白色音符，
// 这里既不复刻那块深色画布，也不画音符。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

// 飞牛：深蓝（原来是黑底，改成识别色相底，和本目录其他图标同一套底板）。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M13.5 24a10.5 10.5 0 1 0 21 0a10.5 10.5 0 1 0-21 0' },
    { kind: 'outline', d: 'M24 29.5V18' },
    { kind: 'outline', d: 'M18.6 23.2L24 17.8l5.4 5.4' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#1E3A8A',
    description: '自绘占位图：深蓝底 + 白色圆环里一个朝上的箭头',
});

export default art;
