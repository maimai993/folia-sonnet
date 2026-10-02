// src/library/core/contracts/session.ts
// 跨 suite 的浏览会话。会话只存语义（筛选词、条目键），布局坐标由各 suite 自己存。
// （原先这里还有 renderer 标识 LibraryRendererId；R3 起换成 suite 契约里的 LibrarySuiteId。）

/** 跨 renderer 保留的浏览会话；布局坐标不在这里，由各 renderer 自己存。 */
export type LibraryBrowseSession = {
    query: string;
    focusedEntryKey: string | null;
};
