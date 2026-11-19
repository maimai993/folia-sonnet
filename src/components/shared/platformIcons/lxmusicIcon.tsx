// src/components/shared/platformIcons/lxmusicIcon.tsx
// 洛雪音源的**自绘**占位图标：一段连着的双符头音符 + 一个朝下的箭头（取自它原本的「取回」含义）。
// 这是自绘图形，不是对方图标的复刻：现用的 lxmusic.png 是对方自己的图标，本文件只借「绿色 + 音符」
// 这两条最粗的线索重新画。

import type { PlatformIconArt } from './platformIconShapes';

// 洛雪：绿。识别线索是「音符 + 取回」。
const art: PlatformIconArt = {
    background: '#059669',
    description: '自绘占位图：绿底 + 白色双符头音符加一个朝下的箭头',
    content: [
        '<g fill="#FFFFFF"><circle cx="18" cy="30" r="4.2"/><circle cx="30" cy="27.5" r="4.2"/></g>',
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<path d="M22.2 30V18l11.9-3v12.5"/>',
        '<path d="M31.5 34.5v6"/><path d="M28.5 37.5L31.5 40.5l3-3"/>',
        '</g>',
    ].join(''),
};

export default art;
