import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCommandPaletteMatches } from './commandRegistry';
import type { CommandPaletteContext } from './types';

// src/components/command-palette/useCommandPalette.ts
// Manages palette state, keyboard opening, and selected autocomplete item.

const isTextEntryTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const tagName = target.tagName.toLowerCase();
    return tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || target.isContentEditable;
};

type UseCommandPaletteParams = {
    currentView: 'home' | 'player';
    isBlocked: boolean;
    context: CommandPaletteContext;
};

export const useCommandPalette = ({
    currentView,
    isBlocked,
    context,
}: UseCommandPaletteParams) => {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const matches = useMemo(() => getCommandPaletteMatches(query), [query]);

    const open = useCallback(() => {
        if (currentView !== 'player' || isBlocked) {
            return;
        }
        setIsOpen(true);
        setActiveIndex(0);
    }, [currentView, isBlocked]);

    const close = useCallback(() => {
        setIsOpen(false);
        setQuery('');
        setActiveIndex(0);
    }, []);

    const executeMatch = useCallback(async (index: number) => {
        const match = matches[index];
        if (!match) {
            return false;
        }

        const input = match.input || (match.command.requiresInput ? query.trim() : '');
        const didExecute = await match.command.execute(input, context);
        if (didExecute) {
            close();
        }
        return didExecute;
    }, [close, context, matches, query]);

    const executeActive = useCallback(() => executeMatch(activeIndex), [activeIndex, executeMatch]);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    useEffect(() => {
        if (activeIndex >= matches.length) {
            setActiveIndex(Math.max(0, matches.length - 1));
        }
    }, [activeIndex, matches.length]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== 'KeyS') {
                return;
            }
            if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
                return;
            }
            if (isTextEntryTarget(event.target)) {
                return;
            }
            if (currentView !== 'player' || isBlocked) {
                return;
            }

            event.preventDefault();
            open();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentView, isBlocked, open]);

    return {
        activeIndex,
        close,
        executeActive,
        executeMatch,
        isOpen,
        matches,
        open,
        query,
        setActiveIndex,
        setQuery,
    };
};
