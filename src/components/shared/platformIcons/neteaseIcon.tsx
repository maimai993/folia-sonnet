// src/components/shared/platformIcons/neteaseIcon.tsx
// 网易云音乐的**自绘**图标：一圈留了豁口的回旋环，环心一颗实心点，示意音符绕成涡卷。
// 这是自绘图形，不是官方 logo：只借「红色」这一个识别色相，不复制官方涡卷的具体曲率与起收笔。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';

// 网易云：红。识别线索是「绕圈」——外环留一道豁口，环心再收一个实心点，旁边一小段回声弧。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M24 12a12 12 0 1 1-8.5 3.5' },
    { kind: 'stroke', d: 'M20.4 24a3.6 3.6 0 1 0 7.2 0a3.6 3.6 0 1 0-7.2 0', fill: W },
    { kind: 'outline', d: 'M31.6 33.2a9 9 0 0 0 5.8-7.6' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#DC2626',
    description: '自绘占位图：红底 + 一圈留了豁口的环、环心一颗实心点与一小段回声弧',
});

export default art;
