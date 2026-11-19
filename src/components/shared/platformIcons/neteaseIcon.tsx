// src/components/shared/platformIcons/neteaseIcon.tsx
// 网易云音乐的**自绘**占位图标：一个同心回旋的音符涡卷抽象成一圈圈同心的弧线。
// 这是自绘图形，不是官方 logo：只借「红色」这一个识别色相，不复制官方涡卷的具体曲率与起收笔。

import type { PlatformIconArt } from './platformIconShapes';

// 网易云：红。识别线索是「绕圈」——三圈同心的弧，故意留着豁口，和官方的连续涡卷不是一回事。
const art: PlatformIconArt = {
    background: '#DC2626',
    description: '自绘占位图：红底 + 三圈带豁口的同心弧线，示意「绕圈」的音符涡卷',
    content: [
        '<g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round">',
        '<path d="M24 12a12 12 0 1 1-8.5 3.5"/>',
        '<path d="M24 18a6 6 0 1 0-4.2 10.2"/>',
        '<path d="M24 24"/>',
        '</g>',
        '<circle cx="24" cy="24" r="2.4" fill="#FFFFFF"/>',
    ].join(''),
};

export default art;
