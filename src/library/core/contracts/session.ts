// src/library/core/contracts/session.ts
// 跨 renderer 的浏览会话与 renderer 标识。会话只存语义（筛选词、条目键），布局坐标由各 renderer 自己存。

/** 跨 renderer 保留的浏览会话；布局坐标不在这里，由各 renderer 自己存。 */
export type LibraryBrowseSession = {
    query: string;
    focusedEntryKey: string | null;
};

export type LibraryRendererId = 'grid' | 'tui';
