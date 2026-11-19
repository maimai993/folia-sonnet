// src/components/shared/platformIcons/fallbackIcon.tsx
// 兜底图标：没登记的来源（本地曲库、mod 加进来的平台、将来的新平台）一律用它。
// 和 Folia 本尊的图标一样是**自绘**的：一个中性的几何记号，不指向任何第三方。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。这一枚只有线，所以内容全是 `outline`。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

// 中性灰：不带识别色相，一看就知道「这个来源没有专属图标」。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M13 24a11 11 0 1 0 22 0a11 11 0 1 0-22 0' },
    { kind: 'outline', d: 'M24 15.5v17' },
    { kind: 'outline', d: 'M15.5 24h17' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#5D5D66',
    description: '自绘占位图：中性灰底 + 一个同心圆记号（兜底）',
});

export default art;
