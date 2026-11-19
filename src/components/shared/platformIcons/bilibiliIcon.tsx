// src/components/shared/platformIcons/bilibiliIcon.tsx
// B 站的**自绘**占位图标：一台极简的「显示器 + 两根天线」，只取粉色这一个识别色相。
// 这是自绘图形，不是官方 logo：现用的 src/assets/providers/bilibili.svg 是官方电视造型的矢量复刻，
// 本文件刻意不画眼睛、不画 512 画布那一套比例，只留「带天线的方屏」这个大类线索。

import type { PlatformIconArt } from './platformIconShapes';

// B 站：粉。识别线索是「带天线的屏幕」——两根斜天线 + 一个圆角方屏。
const art: PlatformIconArt = {
    background: '#FB7299',
    description: '自绘占位图：粉底 + 白色带天线的圆角方屏（不画眼睛、不复刻官方电视）',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<path d="M19 15.5l3.5 3.5"/><path d="M29 15.5L25.5 19"/>',
        '<rect x="12.5" y="19" width="23" height="16" rx="5"/>',
        '<path d="M24 23v8"/><path d="M20 27h8"/>',
        '</g>',
    ].join(''),
};

export default art;
