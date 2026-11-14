import React from 'react';
import type { LibrarySuiteManifest } from '../../core/suite/suite.contract';

// src/library/suites/rhine/entry.ts
// 「莱茵生命」suite：横屏的三维专辑架。
//
// 为什么只实现 home：suite 的 surface 可以只实现一部分，没实现的**逐 surface 回退**
// 到默认 suite（grid）。第一步只需要首页换成架子，集合/歌手/账户照旧用网格 ——
// 这样不会因为一个试验性 suite 把整条浏览链路弄断。
//
// actions 声明为空是**故意的**：这一步的架子只负责「看」，还没有实现导入/筛选这些动作。
// 声明了却做不到，等于对宿主的门控说谎（命令面板会出现点了没反应的项）。
//
// 非默认 suite 的组件必须是 React.lazy —— registry 用 eager glob 发现 entry，
// 但组件本身要按需加载，否则整套 suite 会跟着主包一起进首屏。
const RhineHome = React.lazy(() => import('./RhineHome'));

const rhine: LibrarySuiteManifest = {
    id: 'rhine',
    labelKey: 'libraryRhine.rendererRhine',
    surfaces: {
        home: {
            component: RhineHome,
            actions: [],
        },
    },
};

export default rhine;
