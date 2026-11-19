// src/components/shared/platformIcons/ytmIcon.tsx
// YouTube Music 的**自绘**图标：一个圆盘里放播放三角，再叠两道高矮不一的「音轨条」。
// 这是自绘图形，不是官方 logo：官方是纯白底 + 一个大红圆，这里改成红底白线的圆盘 + 竖条，
// 三角也缩小、挪到中心偏左。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';

// YouTube Music：红。识别线索是「播放」——圆盘里一个三角，旁边两道竖条。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M13 24a8 8 0 1 0 16 0a8 8 0 1 0-16 0' },
    { kind: 'stroke', d: 'M18.7 19.6L24.9 24l-6.2 4.4Z', fill: W, stroke: { color: W, width: 2 } },
    { kind: 'outline', d: 'M33 21.4v5.2' },
    { kind: 'outline', d: 'M36.5 18.6v10.8' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#E11D48',
    description: '自绘占位图：红底 + 白色圆盘里的播放三角与两道音轨条',
});

export default art;
