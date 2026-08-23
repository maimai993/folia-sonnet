import { useCallback, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { CommandPaletteContext } from './types';
import { buildQueueSearchIndex, evaluateQueueSearch, type QueueSearchSuggestion } from './queueSearch';
import { replaceQueueAction, replaceQueueFacet } from './queueQuery';

// src/components/command-palette/useCommandPaletteQueue.ts
// Owns queue-specific derived search state, completion, token clearing, and batch execution.

type UseCommandPaletteQueueParams = {
    activeCommandId: string | null;
    context: CommandPaletteContext;
    isExecuting: boolean;
    query: string;
    close: () => void;
    setActiveIndex: Dispatch<SetStateAction<number>>;
    setIsExecuting: Dispatch<SetStateAction<boolean>>;
    setMatchQuery: Dispatch<SetStateAction<string>>;
    setQuery: Dispatch<SetStateAction<string>>;
};

export const useCommandPaletteQueue = ({
    activeCommandId,
    context,
    isExecuting,
    query,
    close,
    setActiveIndex,
    setIsExecuting,
    setMatchQuery,
    setQuery,
}: UseCommandPaletteQueueParams) => {
    const searchIndex = useMemo(() => buildQueueSearchIndex(context.playQueue), [context.playQueue]);
    const search = useMemo(() => (
        activeCommandId === 'queue'
            ? evaluateQueueSearch(searchIndex, context.currentSong, query)
            : null
    ), [activeCommandId, context.currentSong, query, searchIndex]);

    const acceptSuggestion = useCallback((suggestion: QueueSearchSuggestion) => {
        setQuery(suggestion.replacement);
        setMatchQuery(suggestion.replacement);
        setActiveIndex(0);
    }, [setActiveIndex, setMatchQuery, setQuery]);

    const executeBatch = useCallback(async () => {
        const action = search?.parsed.action;
        if (
            !action
            || !search.hasMeaningfulFilter
            || search.eligibleTargetIndices.length === 0
            || isExecuting
        ) {
            return false;
        }

        setIsExecuting(true);
        try {
            const didExecute = context.applyQueueBatchOperation(action, search.eligibleTargetIndices);
            if (didExecute) close();
            return didExecute;
        } finally {
            setIsExecuting(false);
        }
    }, [close, context, isExecuting, search, setIsExecuting]);

    const clearAction = useCallback(() => {
        const nextQuery = replaceQueueAction(query, null);
        setQuery(nextQuery);
        setMatchQuery(nextQuery);
    }, [query, setMatchQuery, setQuery]);

    const clearFacet = useCallback(() => {
        const nextQuery = replaceQueueFacet(query, null);
        setQuery(nextQuery);
        setMatchQuery(nextQuery);
    }, [query, setMatchQuery, setQuery]);

    return {
        search,
        acceptSuggestion,
        clearAction,
        clearFacet,
        executeBatch,
    };
};
