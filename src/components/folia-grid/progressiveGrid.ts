// Shared progressive-grid state helpers for GridView and ArtistGridView.

export const deriveProgressiveLoadingState = (
    itemCount: number,
    initialSourcesLoading: boolean,
    backgroundSourceLoading: boolean
) => ({
    initialLoading: itemCount === 0 && initialSourcesLoading,
    backgroundLoading: itemCount > 0 && (initialSourcesLoading || backgroundSourceLoading),
});

// 分页去重属于集合数据本身，搬到了 utils/libraryUi/collectionPaging；保留旧导出。
export { appendUniqueByKey } from '../../utils/libraryUi/collectionPaging';
