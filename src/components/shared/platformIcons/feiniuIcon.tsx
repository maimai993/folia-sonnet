// src/components/shared/platformIcons/feiniuIcon.tsx
// 飞牛的**自绘**占位图标：一个朝上的箭头穿进圆环，取深蓝这一个识别色相。
// 这是自绘图形，不是官方 logo：现用的 feiniu.png 是对方自带的深色画布 + 红色圆 + 白色音符，
// 这里既不复刻那块深色画布，也不画音符。

import type { PlatformIconArt } from './platformIconShapes';

// 飞牛：深蓝（原来是黑底，改成识别色相底，和本目录其他图标同一套底板）。
const art: PlatformIconArt = {
    background: '#1E3A8A',
    description: '自绘占位图：深蓝底 + 白色圆环里一个朝上的箭头',
    content: [
        '<circle cx="24" cy="24" r="10" fill="none" stroke="#FFFFFF" stroke-width="3"/>',
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<path d="M24 29V19"/><path d="M19 23.5L24 18.5l5 5"/>',
        '</g>',
    ].join(''),
};

export default art;
