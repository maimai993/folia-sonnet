// src/components/shared/platformIcons/qishuiIcon.tsx
// 汽水的**自绘**占位图标：一个简单的气泡（「汽」）里放一个播放三角。
// 这是自绘图形，不是官方 logo：官方那颗带斜切的渐变音符一概不复刻，配色也还原到偏青的绿。

import type { PlatformIconArt } from './platformIconShapes';

// 汽水：青绿。识别线索是「汽泡 / 播放」——圆气泡加一个朝右的三角。
const art: PlatformIconArt = {
    background: '#19A58C',
    description: '自绘占位图：青绿底 + 白色圆形气泡里一个播放三角',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<rect x="12" y="14" width="24" height="20" rx="10"/>',
        '<path d="M21.5 19.5v9l7.5-4.5z" fill="#FFFFFF"/>',
        '</g>',
    ].join(''),
};

export default art;
