import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionView } from '../../hooks/libraryUi/useCollectionView';
import {
    getLibraryBrowseSession,
    registerLibrarySessionFlush,
    useLibraryBrowseSessionStore,
} from '../../stores/useLibraryBrowseSessionStore';

// src/components/library-tui/useLibraryTuiFocus.ts
// TUI 的焦点按条目键记，而不是按行号：筛选变了、分页追加了，同一首仍是同一首；
// 焦点那首不在当前行里时落到第一行。初值取自浏览会话（例如刚从网格切过来）。

export const useLibraryTuiFocus = (sessionKey: string, view: CollectionView) => {
    /** 每一行对应的展示下标（在 view.displayTracks 里）。 */
    const rowDisplayIndexes = useMemo(
        () => view.matchIndexes ?? view.displayTracks.map((_, index) => index),
        [view.displayTracks, view.matchIndexes],
    );
    const rowKeys = useMemo(
        () => rowDisplayIndexes.map(index => view.entryKeyAt(index) ?? ''),
        [rowDisplayIndexes, view],
    );

    const [focusedKey, setFocusedKey] = useState<string | null>(() => getLibraryBrowseSession(sessionKey).focusedEntryKey);
    const focusedKeyRef = useRef(focusedKey);
    focusedKeyRef.current = focusedKey;

    const found = focusedKey ? rowKeys.indexOf(focusedKey) : -1;
    const focusedRow = rowKeys.length === 0 ? -1 : Math.max(found, 0);

    const moveFocus = useCallback((resolve: (current: number) => number) => {
        if (rowKeys.length === 0) return;
        const next = resolve(Math.max(focusedRow, 0));
        setFocusedKey(rowKeys[Math.max(0, Math.min(next, rowKeys.length - 1))] ?? null);
    }, [focusedRow, rowKeys]);

    const focusRow = useCallback((row: number) => moveFocus(() => row), [moveFocus]);

    /** 把焦点写回会话（播放、切换 renderer 之前）；给了行号就写那一行（例如双击的行）。 */
    const persistFocus = useCallback((row: number = focusedRow) => {
        const key = row >= 0 ? rowKeys[row] : focusedKeyRef.current;
        useLibraryBrowseSessionStore.getState().setFocusedEntry(sessionKey, key || null);
    }, [focusedRow, rowKeys, sessionKey]);

    useEffect(() => registerLibrarySessionFlush(sessionKey, () => persistFocus()), [persistFocus, sessionKey]);

    return { rowDisplayIndexes, focusedRow, moveFocus, focusRow, persistFocus };
};
