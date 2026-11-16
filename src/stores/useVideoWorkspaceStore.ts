// src/stores/useVideoWorkspaceStore.ts
// 影视工作台的开关。入口在设置页「影视」那一组里，工作台本身是覆盖在首页上的一层，
// 所以开关单独放一个 store，不挂在任何一个页面的生命周期上。

import { create } from 'zustand';

interface VideoWorkspaceState {
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
}

export const useVideoWorkspaceStore = create<VideoWorkspaceState>((set, get) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set({ open: !get().open }),
}));
