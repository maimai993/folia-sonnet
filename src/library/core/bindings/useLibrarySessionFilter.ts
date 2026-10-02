import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useGridCommandFilter } from '../../../hooks/useGridCommandFilter';
import { openCommandFilter } from '../../../stores/useAppViewStore';
import { useLibraryBrowseSessionStore } from '../state/useLibraryBrowseSessionStore';

// src/library/core/bindings/useLibrarySessionFilter.ts
// renderer 的筛选词读写会话，而不是自己的组件状态：换 renderer 时筛选还在。键入仍交给命令面板
// （见 useGridCommandFilter），这里只多做一件事：挂载时会话里已有筛选，就把筛选框带出来，
// 否则界面是筛过的、屏幕上却没有任何说明。

export const useLibrarySessionFilter = ({
    sessionKey,
    isInteractive,
    anchorRef,
}: {
    sessionKey: string;
    isInteractive: boolean;
    anchorRef: RefObject<HTMLElement | null>;
}) => {
    const query = useLibraryBrowseSessionStore(state => state.sessions[sessionKey]?.query ?? '');
    const setQuery = useCallback(
        (next: string) => useLibraryBrowseSessionStore.getState().setQuery(sessionKey, next),
        [sessionKey],
    );
    const isFiltering = useGridCommandFilter({ isInteractive, query, setQuery, anchorRef });

    const reopenedRef = useRef(false);
    useEffect(() => {
        if (reopenedRef.current || !isInteractive) return;
        reopenedRef.current = true;
        if (query) openCommandFilter();
        // 只在第一次可交互时检查一次。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isInteractive]);

    return { query, setQuery, isFiltering };
};
