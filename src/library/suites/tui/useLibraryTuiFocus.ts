import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CollectionView } from '../../core/bindings/useCollectionView';
import { resolveRowAfterRemoval } from '../../core/model/collectionEntries';
import {
    getLibraryBrowseSession,
    registerLibrarySessionFlush,
    useLibraryBrowseSessionStore,
} from '../../core/state/useLibraryBrowseSessionStore';

// src/library/suites/tui/useLibraryTuiFocus.ts
// TUI 的焦点按条目键记，而不是按行号：筛选变了、分页追加了，同一首仍是同一首；
// 焦点那首不在当前行里时落到第一行。初值取自浏览会话（例如刚从网格切过来）。
// 例外是删除：焦点条目被删掉（或被替换）之后，焦点落在原位置的下一行，删的是最后一行就落到上一行
// （core/model/collectionEntries 的 resolveRowAfterRemoval）。

/** 一次删除发起时的焦点：它从行里消失时据此换算新焦点。 */
type PendingRemovalFocus = {
    key: string;
    row: number;
    rowKeys: readonly string[];
    /** 发起时的筛选：筛选变了，消失就不是删除造成的。 */
    query: string;
};

export const useLibraryTuiFocus = (sessionKey: string, view: CollectionView, committedQuery = '') => {
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

    const [removal, setRemoval] = useState<PendingRemovalFocus | null>(null);

    // 焦点条目在删除之后消失：换算成原位置的下一行。渲染时就用换算结果（不闪到第一行），随后写回状态。
    let effectiveKey = focusedKey;
    const foundKey = focusedKey ? rowKeys.indexOf(focusedKey) : -1;
    const settlesRemoval = Boolean(removal)
        && removal!.key === focusedKey
        && removal!.query === committedQuery
        && foundKey < 0
        && removal!.rowKeys !== rowKeys;
    if (settlesRemoval) {
        const row = resolveRowAfterRemoval(removal!.rowKeys, removal!.row, rowKeys);
        effectiveKey = row >= 0 ? rowKeys[row] : null;
    }
    useLayoutEffect(() => {
        if (!settlesRemoval) return;
        setFocusedKey(effectiveKey);
        setRemoval(null);
    }, [effectiveKey, settlesRemoval]);

    const found = effectiveKey ? rowKeys.indexOf(effectiveKey) : -1;
    const focusedRow = rowKeys.length === 0 ? -1 : Math.max(found, 0);

    const moveFocus = useCallback((resolve: (current: number) => number) => {
        if (rowKeys.length === 0) return;
        const next = resolve(Math.max(focusedRow, 0));
        setRemoval(null);
        setFocusedKey(rowKeys[Math.max(0, Math.min(next, rowKeys.length - 1))] ?? null);
    }, [focusedRow, rowKeys]);

    /** 删除焦点行之前调用：它消失时焦点落到原位置的下一行。 */
    const markRemoval = useCallback((row: number) => {
        const key = rowKeys[row];
        if (!key) return;
        setFocusedKey(key);
        setRemoval({ key, row, rowKeys, query: committedQuery });
    }, [committedQuery, rowKeys]);

    /** 删除没做成时撤掉标记（做成了不撤：行可能还没换成新的，等它消失时换算）。 */
    const clearRemoval = useCallback((key: string) => {
        setRemoval(current => (current?.key === key ? null : current));
    }, []);

    const focusRow = useCallback((row: number) => moveFocus(() => row), [moveFocus]);

    /** 把焦点写回会话（播放、切换 renderer 之前）；给了行号就写那一行（例如双击的行）。 */
    const persistFocus = useCallback((row: number = focusedRow) => {
        const key = row >= 0 ? rowKeys[row] : focusedKeyRef.current;
        useLibraryBrowseSessionStore.getState().setFocusedEntry(sessionKey, key || null);
    }, [focusedRow, rowKeys, sessionKey]);

    useEffect(() => registerLibrarySessionFlush(sessionKey, () => persistFocus()), [persistFocus, sessionKey]);

    return { rowDisplayIndexes, rowKeys, focusedRow, moveFocus, focusRow, persistFocus, markRemoval, clearRemoval };
};
