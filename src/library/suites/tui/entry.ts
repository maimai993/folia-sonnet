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
                // 与 LibraryTuiView 现在做得到的一致：播放 / 入队焦点行与范围、筛选、本地排序、重新拉取、续传；
                // 变更动作：Delete 删焦点条目（每日推荐是不喜欢）、状态栏的订阅星标 / 改名 / 删除集合 / 每日推荐日期、
                // 行上的手动匹配，来源维护（重扫、导出、编辑实体、整理）经命令面板。
                // 不声明 add-to-playlist / create-playlist：Navidrome 加入歌单要一个歌单选择器，TUI 还没有，
                // 这两个动作只在网格里出现。
                actions: [
                    'play',
                    'enqueue',
                    'play-scope',
                    'enqueue-scope',
                    'filter',
                    'sort',
                    'reload',
                    'resume-sync',
                    'remove-entry',
                    'subscribe',
                    'rename',
                    'delete-collection',
                    'resync-folder',
                    'resync-all-folders',
                    'export-playlist',
                    'edit-entity',
                    'organize-song-info',
                    'match-song',
                    'daily-date',
                ],
            },
        }
        : {},
};

export default tui;
