// src/library/core/contracts/directory.ts
// 首页目录的契约。目前只有本地文件夹树的节点：service 构建它、网格的 GridMap 批量面板展示它，
// 所以它不能住在网格 suite 里。P3.1 会把目录条目、批量上下文一并收进来（届时改名 LibraryDirectoryNode）。

/** 本地文件夹树的一个节点（只含目录，不含曲目）。 */
export interface GridMapDirectoryNode {
    id: string;
    name: string;
    path: string;
    rootPath: string;
    depth: number;
    ignored?: boolean;
    directTrackCount: number;
    totalTrackCount: number;
    children: GridMapDirectoryNode[];
}
