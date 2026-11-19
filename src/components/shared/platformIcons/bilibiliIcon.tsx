// src/components/shared/platformIcons/bilibiliIcon.tsx
// B 站的**自绘**图标：一台极简的「显示器 + 两根天线」，只取粉色这一个识别色相。
// 这是自绘图形，不是官方 logo：原来那份位图是官方电视造型的矢量复刻，本文件刻意不画眼睛、
// 不画 512 画布那一套比例，只留「带天线的方屏」这个大类线索。
//
// 笔画分两种（见 platformIconShapes 的 PlatformIconGesture）：`outline` 是只描边不填充的外框，
// `stroke` 是实心的一笔。同一份数据既拼成图标，也机械转成安卓通知栏的纯白剪影。

import { platformIconArt, type PlatformIconArt, type PlatformIconGesture } from './platformIconShapes';

const W = '#FFFFFF';

// B 站：粉。识别线索是「带天线的屏幕」——两根斜天线 + 一个圆角方屏 + 屏心一道十字。
const gestures: PlatformIconGesture[] = [
    { kind: 'outline', d: 'M19.2 15.4l3.4 3.4' },
    { kind: 'outline', d: 'M28.8 15.4l-3.4 3.4' },
    { kind: 'outline', d: 'M12 20h24v14H12Z' },
    { kind: 'outline', d: 'M24 23v9' },
    { kind: 'outline', d: 'M19.5 27.5h9' },
];

const art: PlatformIconArt = platformIconArt({
    gestures,
    background: '#FB7299',
    description: '自绘占位图：粉底 + 白色带天线的方屏（不画眼睛、不复刻官方电视）',
});

export default art;
