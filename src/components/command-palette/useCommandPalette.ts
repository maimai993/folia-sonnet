import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAvailableCommandPaletteCommands, getCommandPaletteMatches, getQueueSongMatchesFromEvaluation, COMMAND_PALETTE_COMMANDS } from './commandRegistry';
import { isRecordableRecentCommand, readRecentCommandIds, recordRecentCommandId, resolveRecentCommandToRecord } from './recentCommands';
import type { CommandPaletteContext, CommandPaletteCommand, CommandPaletteMatch } from './types';
import { useSettingsUiStore } from '../../stores/useSettingsUiStore';
import { resolvePinnedCommandSlots } from './pinnedCommandPreferences';
import { useCommandPaletteQueue } from './useCommandPaletteQueue';

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
    const [matchQuery, setMatchQuery] = useState('');
    const [isComposing, setIsComposing] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [activeCommand, setActiveCommand] = useState<CommandPaletteCommand | null>(null);
    const [isExecuting, setIsExecuting] = useState(false);
    const [recentCommandIds, setRecentCommandIds] = useState<string[]>(() => readRecentCommandIds());
    const close = useCallback(() => {
        setIsOpen(false);
        setQuery('');
        setMatchQuery('');
        setIsComposing(false);
        setActiveIndex(0);
        setActiveCommand(null);
        setIsExecuting(false);
    }, []);
    const pinnedCommandIds = useSettingsUiStore(state => state.pinnedCommandIds);
    const availableCommands = useMemo(() => getAvailableCommandPaletteCommands(context), [context]);
    const pinnedCommands = useMemo(
        () => resolvePinnedCommandSlots(pinnedCommandIds, availableCommands),
        [availableCommands, pinnedCommandIds],
    );
    const {
        search: queueSearch,
        acceptSuggestion: acceptQueueSuggestion,
        clearAction: clearQueueAction,
        clearFacet: clearQueueFacet,
        executeBatch: executeQueueBatch,
    } = useCommandPaletteQueue({
        activeCommandId: activeCommand?.id ?? null,
        context,
        isExecuting,
        query,
        close,
        setActiveIndex,
        setIsExecuting,
        setMatchQuery,
        setQuery,
    });

    const matches = useMemo(() => {
        const activeInput = activeCommand?.id === 'playback-volume' ? query : matchQuery;
        let list: CommandPaletteMatch[];
        if (!activeCommand) {
            list = getCommandPaletteMatches(matchQuery, context, recentCommandIds);
        } else if (activeCommand.id === 'queue' && queueSearch) {
            list = getQueueSongMatchesFromEvaluation(queueSearch, query, context);
        } else {
            const inputCommands = COMMAND_PALETTE_COMMANDS.filter(cmd => cmd.requiresInput);
            const activeMatch: CommandPaletteMatch = {
                command: activeCommand,
                score: 100,
                input: activeInput,
            };
            const otherMatches: CommandPaletteMatch[] = inputCommands
                .filter(cmd => cmd.id !== activeCommand.id)
                .filter(cmd => {
                    if (cmd.id === 'search-current') return true;
                    return false;
                })
                .map((cmd, idx) => ({
                    command: cmd,
                    score: 90 - idx,
                    input: activeInput,
                }));
            list = [activeMatch, ...otherMatches];
        }

        return list.map(match => {
            let previewText: string | null = null;
            if (match.command.getPreview && (!match.command.requiresInput || match.input)) {
                previewText = match.command.getPreview(match.input, context);
            }
            return {
                ...match,
                previewText,
            };
        });
    }, [activeCommand, matchQuery, query, context, recentCommandIds, queueSearch]);

    const activePreview = useMemo(() => {
        const match = matches[activeIndex];
        return match?.previewText || null;
    }, [activeIndex, matches]);

    const open = useCallback(() => {
        if (currentView !== 'player' || isBlocked) {
            return;
        }
        setIsOpen(true);
        setActiveIndex(0);
    }, [currentView, isBlocked]);

    const recordRecentCommand = useCallback((command: CommandPaletteCommand) => {
        if (isRecordableRecentCommand(command, COMMAND_PALETTE_COMMANDS)) {
            setRecentCommandIds(currentCommandIds => recordRecentCommandId(command.id, currentCommandIds));
        }
    }, []);

    const activateInputCommand = useCallback((command: CommandPaletteCommand) => {
        const initialInput = command.getInitialInput?.(context) ?? '';
        recordRecentCommand(command);
        setActiveCommand(command);
        setQuery(initialInput);
        setMatchQuery(initialInput);
        setActiveIndex(0);
    }, [context, recordRecentCommand]);

    const openQueue = useCallback(() => {
        if (currentView !== 'player' || isBlocked || isExecuting) {
            return;
        }

        const queueCommand = COMMAND_PALETTE_COMMANDS.find(command => command.id === 'queue');
        if (!queueCommand) {
            return;
        }

        setIsOpen(true);
        setIsComposing(false);
        activateInputCommand(queueCommand);
    }, [activateInputCommand, currentView, isBlocked, isExecuting]);

    const executeMatch = useCallback(async (index: number) => {
        if (isExecuting) {
            return false;
        }

        const match = matches[index];
        if (!match) {
            return false;
        }

        const input = match.input;
        if (match.command.requiresInput && !activeCommand) {
            if (!input) {
                activateInputCommand(match.command);
                return false;
            }
        }

        if (match.command.requiresInput && !input) {
            return false;
        }

        setIsExecuting(true);
        try {
            const didExecute = await match.command.execute(input, context);
            if (didExecute) {
                recordRecentCommand(resolveRecentCommandToRecord(match.command, activeCommand));
                close();
            }
            return didExecute;
        } finally {
            setIsExecuting(false);
        }
    }, [activateInputCommand, close, context, activeCommand, matches, isExecuting, recordRecentCommand]);

    const executeActive = useCallback(() => {
        if (activeCommand?.id === 'queue' && queueSearch) {
            const [suggestion] = queueSearch.suggestions;
            if (suggestion) {
                acceptQueueSuggestion(suggestion);
                return Promise.resolve(false);
            }
            if (queueSearch.parsed.action) {
                return executeQueueBatch();
            }
        }
        return executeMatch(activeIndex);
    }, [acceptQueueSuggestion, activeCommand?.id, activeIndex, executeMatch, executeQueueBatch, queueSearch]);

    const executePinnedCommand = useCallback(async (command: CommandPaletteCommand) => {
        if (isExecuting) {
            return false;
        }
        if (command.requiresInput) {
            activateInputCommand(command);
            return false;
        }

        setIsExecuting(true);
        try {
            const didExecute = await command.execute('', context);
            if (didExecute) {
                recordRecentCommand(command);
                close();
            }
            return didExecute;
        } finally {
            setIsExecuting(false);
        }
    }, [activateInputCommand, close, context, isExecuting, recordRecentCommand]);

    useEffect(() => {
        setActiveIndex(0);
    }, [matchQuery]);

    // Space-to-pill conversion for commands requiring input
    useEffect(() => {
        if (!isOpen || isComposing || activeCommand) {
            return;
        }

        if (query.endsWith(' ')) {
            const trimmed = query.trim();
            if (trimmed) {
                const matchedCmd = COMMAND_PALETTE_COMMANDS.find(cmd =>
                    cmd.requiresInput &&
                    cmd.keywords.some(kw => kw.toLowerCase() === trimmed.toLowerCase())
                );
                if (matchedCmd) {
                    activateInputCommand(matchedCmd);
                }
            }
        }
    }, [activateInputCommand, query, isComposing, isOpen, activeCommand]);

    useEffect(() => {
        if (!isOpen || isComposing) {
            return undefined;
        }

        const timer = window.setTimeout(() => {
            setMatchQuery(query);
        }, 120);

        return () => window.clearTimeout(timer);
    }, [isComposing, isOpen, query]);

    useEffect(() => {
        if (activeIndex >= matches.length) {
            setActiveIndex(Math.max(0, matches.length - 1));
        }
    }, [activeIndex, matches.length]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.code === 'KeyP'
                && event.ctrlKey
                && !event.altKey
                && !event.metaKey
                && !event.shiftKey
            ) {
                if (currentView !== 'player' || isBlocked) {
                    return;
                }

                event.preventDefault();
                openQueue();
                return;
            }

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
    }, [currentView, isBlocked, open, openQueue]);

    return {
        activeIndex,
        activePreview,
        activeCommand,
        availableCommands,
        setActiveCommand,
        isExecuting,
        close,
        executeActive,
        executeMatch,
        isOpen,
        isComposing,
        matches,
        open,
        pinnedCommands,
        query,
        queueSearch,
        acceptQueueSuggestion,
        clearQueueAction,
        clearQueueFacet,
        executeQueueBatch,
        setActiveIndex,
        setIsComposing,
        setMatchQuery,
        setQuery,
        executePinnedCommand,
    };
};
