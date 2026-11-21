// src/components/shared/platformIcons/qqIcon.tsx
// QQ 音乐的**自绘**图标：一个通用的「双符杆音符」几何形，只保留黄绿这一族识别色相。
// 这是自绘图形，不是官方 logo：不复制官方那颗斜切的音符造型。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const G = '#14532D';

// QQ 音乐：黄绿。识别线索是「音符」——两个实心符头 + 一根带符尾的符杆，最基本的音乐记号。
const gestures: PlatformIconGesture[] = [
    { kind: 'stroke', d: 'M14.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0-9.2 0', fill: G },
    { kind: 'stroke', d: 'M26.9 27.5a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0-9.2 0', fill: G },
    { kind: 'outline', d: 'M23.6 32V17.5L36.1 14.2V23.6' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#F5C518',
    description: '自绘占位图：黄底 + 绿色通用音符（两个符头、两根符杆、一道符尾）',
});

export default art;
