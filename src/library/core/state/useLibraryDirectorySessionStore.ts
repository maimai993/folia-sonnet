import { create } from 'zustand';
import type { LibraryDirectorySession, LibraryDirectoryVisibilityMode } from '../contracts/directory';
import {
    EMPTY_DIRECTORY_SESSION,
    replaceDirectorySelection,
    setDirectorySelection,
    toggleDirectorySelection,
} from '../model/directorySession';

// src/library/core/state/useLibraryDirectorySessionStore.ts
// 首页目录的浏览会话：筛选词、按稳定 id 的批选、隐藏视图（manage / manage-hidden-only）。原来是 GridMap 的
// 组件状态；提到这里后网格的 GridMap 与以后的 TUI 目录读写同一份，换 suite 不丢。
//
// 会话按目录 key 分开（core/model/directorySession 的 directoryKey），只在内存里。生命周期跟着「目录被打开」：
// 网格在打开 GridMap 时清一次、在 GridMap 退场结束后再清一次——关掉地图即丢掉筛选与选择，与原先组件状态
// 随卸载消失的语义一致。打开 / 关闭批量面板与 Escape 关面板时清掉选择与隐藏视图（resetSelection）。

type LibraryDirectorySessionState = {
    sessions: Record<string, LibraryDirectorySession>;
    setQuery: (sessionId: string, query: string) => void;
    /** 选中或取消一批条目。 */
    setSelected: (sessionId: string, itemIds: readonly string[], selected: boolean) => void;
    toggleSelected: (sessionId: string, itemId: string) => void;
    /** 用一组 id 替换整个选择（全选筛选结果用它）。 */
    replaceSelection: (sessionId: string, itemIds: readonly string[]) => void;
    setVisibilityMode: (sessionId: string, mode: LibraryDirectoryVisibilityMode) => void;
    /** 清空选择并回到浏览视图（打开 / 关闭批量面板时）。筛选词保留。 */
    resetSelection: (sessionId: string) => void;
    /** 丢掉整个会话（打开、关闭目录地图时）。 */
    clearSession: (sessionId: string) => void;
};

export const useLibraryDirectorySessionStore = create<LibraryDirectorySessionState>((set, get) => {
    // 变换没改动会话（返回同一个对象）就不写、不通知订阅者。
    const update = (sessionId: string, change: (session: LibraryDirectorySession) => LibraryDirectorySession) => {
        const current = get().sessions[sessionId] ?? EMPTY_DIRECTORY_SESSION;
        const next = change(current);
        if (next === current) return;
        set(state => ({ sessions: { ...state.sessions, [sessionId]: next } }));
    };

    return {
        sessions: {},
        setQuery: (sessionId, query) => update(sessionId, session => (
            session.query === query ? session : { ...session, query }
        )),
        setSelected: (sessionId, itemIds, selected) => update(sessionId, session => setDirectorySelection(session, itemIds, selected)),
        toggleSelected: (sessionId, itemId) => update(sessionId, session => toggleDirectorySelection(session, itemId)),
        replaceSelection: (sessionId, itemIds) => update(sessionId, session => replaceDirectorySelection(session, itemIds)),
        setVisibilityMode: (sessionId, mode) => update(sessionId, session => (
            session.visibilityMode === mode ? session : { ...session, visibilityMode: mode }
        )),
        resetSelection: (sessionId) => update(sessionId, session => (
            session.selectedIds.length === 0 && session.visibilityMode === 'browse'
                ? session
                : { ...session, selectedIds: [], visibilityMode: 'browse' }
        )),
        clearSession: (sessionId) => {
            if (!get().sessions[sessionId]) return;
            set(state => {
                const sessions = { ...state.sessions };
                delete sessions[sessionId];
                return { sessions };
            });
        },
    };
});

/** 现读一个目录会话（没有就是空会话）。 */
export const getLibraryDirectorySession = (sessionId: string): LibraryDirectorySession => (
    useLibraryDirectorySessionStore.getState().sessions[sessionId] ?? EMPTY_DIRECTORY_SESSION
);
