import { create } from 'zustand';
import type { LibrarySuiteId } from '../contracts/suite';
import { DEFAULT_LIBRARY_SUITE_ID } from '../model/librarySuites';

// src/library/core/state/useLibrarySuiteStore.ts
// 集合浏览用哪套 UI suite 展示（R3 之前是 useLibraryRendererStore 的 renderer）。目前只有开发版的临时浮层
// 会切换它，所以不持久化、不是设置项；将来成为正式选项时，再按设置集成的规则接入导入导出与命令面板。
// 合法的 id 由 registry 决定（state 不 import registry）；切换走 app/switchLibrarySuite，它会先校验。

type LibrarySuiteState = {
    suite: LibrarySuiteId;
    setSuite: (suite: LibrarySuiteId) => void;
};

export const useLibrarySuiteStore = create<LibrarySuiteState>(set => ({
    suite: DEFAULT_LIBRARY_SUITE_ID,
    setSuite: (suite) => set({ suite }),
}));
