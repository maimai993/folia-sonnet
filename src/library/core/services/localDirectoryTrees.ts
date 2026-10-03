import type { LocalSong } from '../../../types';
import type { LibraryDirectoryNode } from '../contracts/directory';
import type { LibraryLocalDirectoryTreesResource, LibraryLocalDirectoryTreesSnapshot } from '../contracts/homeModel';

// src/library/core/services/localDirectoryTrees.ts
// 本地文件夹树（原 LocalGrid3DView 自己用 loadLocalLibraryDirectoryTrees 读的组件状态）：按导入根的快照与曲库建树，
// 本地文件夹的批量面板与以后的 TUI 目录树都读它。每次 load 领一个 generation，晚到的旧读取丢掉（原先按完成顺序覆盖）；
// 读失败记警告、树为空。读取经注入的 loadTrees（默认装配在 localDirectoryTreesDeps）。

export type LocalDirectoryTreesDeps = {
    loadTrees(songs?: LocalSong[]): Promise<LibraryDirectoryNode[]>;
};

export const createLocalDirectoryTrees = (deps: LocalDirectoryTreesDeps): LibraryLocalDirectoryTreesResource => {
    let snapshot: LibraryLocalDirectoryTreesSnapshot = { trees: [], loaded: false };
    let generation = 0;
    const listeners = new Set<() => void>();

    const commit = (next: LibraryLocalDirectoryTreesSnapshot) => {
        snapshot = next;
        listeners.forEach(listener => listener());
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        load: async (songs) => {
            const ticket = ++generation;
            let trees: LibraryDirectoryNode[];
            try {
                trees = await deps.loadTrees(songs ? [...songs] : undefined);
            } catch (error) {
                console.warn('[LibraryHome] Failed to load directory snapshots:', error);
                trees = [];
            }
            if (ticket !== generation) return;
            commit({ trees, loaded: true });
        },
    };
};
