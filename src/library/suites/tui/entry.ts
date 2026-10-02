import React from 'react';
import type { LibrarySuiteManifest } from '../../core/contracts/suite';

// src/library/suites/tui/entry.ts
// 终端风格的列表 suite（开发版专用的 PoC）。只实现集合 surface；首页与歌手页回退到网格。
// 生产构建里 import.meta.env.DEV 是常量 false：组件那一行连同动态 import 一起被摇掉，不会产出 TUI 的 chunk，
// registry 也因为 available: false 把它当作不存在（浮层不出现、选不到）。

const LibraryTuiView = import.meta.env.DEV ? React.lazy(() => import('./LibraryTuiView')) : null;

const tui: LibrarySuiteManifest = {
    id: 'tui',
    labelKey: 'libraryTui.rendererTui',
    available: import.meta.env.DEV,
    surfaces: LibraryTuiView
        ? {
            collection: {
                component: LibraryTuiView,
                // 与 LibraryTuiView 现在做得到的一致：播放 / 入队焦点行与范围、筛选、本地排序、重新拉取、续传。
                // 变更动作（删除、订阅……）在 P2.4 接入后再声明。
                actions: ['play', 'enqueue', 'play-scope', 'enqueue-scope', 'filter', 'sort', 'reload', 'resume-sync'],
            },
        }
        : {},
};

export default tui;
