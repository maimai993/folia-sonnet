// src/components/shared/platformIcons/wechatIcon.tsx
// 微信的**自绘**图标：一颗带「打字中」横线的对话气泡，左下伸出一根尾巴，右下角再叠一小颗气泡。
// 这是自绘图形，不是官方 logo：只借「绿色」这一个识别色相，不复制官方气泡的具体轮廓与眼睛。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

// 微信：绿。
const gestures: PlatformIconGesture[] = [
    // 主气泡：圆角方框 + 左下角一根小尾巴（尾巴停在框边上，不与轮廓打架）。
    { kind: 'outline', d: 'M14 20h16v11H14Z' },
    { kind: 'outline', d: 'M18 31l-2.5 3.2' },
    // 「打字中」的三道横线。
    { kind: 'outline', d: 'M18.5 23.5h7' },
    { kind: 'outline', d: 'M18.5 27h7' },
    // 右下角叠着的小气泡：一个圆角小方框，右下角一根短尾巴。
    { kind: 'outline', d: 'M26 30h7v6H26Z' },
    { kind: 'outline', d: 'M30 36l2 2.4' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#07C160',
    description: '自绘占位图：绿底 + 一颗带两道横线的对话气泡，右下角叠着一颗小气泡',
});

export default art;
