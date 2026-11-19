// src/components/shared/platformIcons/qqIcon.tsx
// QQ 音乐的**自绘**占位图标：一个通用的「双符杆音符」几何形，只保留黄绿这一族识别色相。
// 这是自绘图形，不是官方 logo：不复制官方那颗斜切的音符造型。

import type { PlatformIconArt } from './platformIconShapes';

// QQ 音乐：黄绿。识别线索是「音符」，用最基本的「符头 + 符杆 + 符尾」三件套画，谁也不像。
const art: PlatformIconArt = {
    background: '#F5C518',
    description: '自绘占位图：黄底 + 绿色通用音符（两个符头、两根符杆、一道符尾）',
    content: [
        '<g fill="#16A34A">',
        '<circle cx="19" cy="32" r="4.6"/>',
        '<circle cx="31.5" cy="29.5" r="4.6"/>',
        '</g>',
        '<g fill="none" stroke="#16A34A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">',
        '<path d="M23.6 32V18.5L36.1 15.2V29.5"/>',
        '</g>',
    ].join(''),
};

export default art;
