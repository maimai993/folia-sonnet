import { create } from 'zustand';
import type { LibraryRendererId } from '../contracts/session';

// src/library/core/state/useLibraryRendererStore.ts
// 集合详情用哪个 renderer 展示。目前只有开发版的临时浮层会切换它，所以不持久化、不是设置项；
// 将来成为正式选项时，再按设置集成的规则接入导入导出与命令面板。

type LibraryRendererState = {
    renderer: LibraryRendererId;
    setRenderer: (renderer: LibraryRendererId) => void;
};

export const useLibraryRendererStore = create<LibraryRendererState>(set => ({
    renderer: 'grid',
    setRenderer: (renderer) => set({ renderer }),
}));
