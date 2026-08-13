import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownLeft, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GridMapItem } from '../GridMap';
import {
    getGridMapQuerySuggestions,
    getGridMapQueryEditorState,
    isGridMapSyntaxQuery,
    parseGridMapQuery,
    updateGridMapQueryEditorValue,
} from './gridMapQuery';

// src/components/folia-grid/GridMapSearchPanel.tsx
// Renders basic live search and explicit, staged query mode as one command-style input.

interface GridMapSearchPanelProps {
    draftQuery: string;
    appliedQuery: string;
    items: GridMapItem[];
    inputRef: React.RefObject<HTMLInputElement | null>;
    onDraftChange: (query: string, applyBasic: boolean) => void;
    onApply: (query: string) => void;
    onDismiss: () => void;
    onClear: () => void;
}

const getModeLabelKey = (operator: 'path' | 'under' | null): string => {
    if (operator) {
        return operator === 'path'
            ? 'home.gridQueryExactPath'
            : 'home.gridQuerySubtree';
    }
    return 'home.gridQueryMode';
};

const GridMapSearchPanel: React.FC<GridMapSearchPanelProps> = ({
    draftQuery,
    appliedQuery,
    items,
    inputRef,
    onDraftChange,
    onApply,
    onDismiss,
    onClear,
}) => {
    const { t } = useTranslation();
    const isSyntaxMode = isGridMapSyntaxQuery(draftQuery);
    const parsedQuery = useMemo(() => parseGridMapQuery(draftQuery), [draftQuery]);
    const editorState = useMemo(() => getGridMapQueryEditorState(draftQuery), [draftQuery]);
    const suggestions = useMemo(
        () => getGridMapQuerySuggestions(draftQuery, items),
        [draftQuery, items],
    );
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const isComposingRef = useRef(false);
    const isDirty = draftQuery !== appliedQuery;

    useEffect(() => {
        setActiveSuggestionIndex(0);
    }, [draftQuery]);

    const updateVisibleValue = (value: string, applyBasic: boolean) => {
        onDraftChange(updateGridMapQueryEditorValue(draftQuery, value), applyBasic);
    };
    const applyQuery = (query = draftQuery) => {
        if (parseGridMapQuery(query).valid) onApply(query);
    };

    return (
        <div className="relative rounded-2xl border shadow-2xl backdrop-blur-2xl theme-glass-panel">
            <div className="flex min-h-12 items-center gap-2 px-3">
                <Search className="h-4 w-4 shrink-0 opacity-40" />
                {isSyntaxMode && (
                    <button
                        type="button"
                        onClick={() => {
                            onClear();
                            requestAnimationFrame(() => inputRef.current?.focus());
                        }}
                        className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-semibold shadow-sm transition-colors hover:bg-white/15"
                        title={t('home.gridQueryExit')}
                    >
                        <span>{t(getModeLabelKey(editorState.operator))}</span>
                        <X size={12} className="opacity-55" />
                    </button>
                )}
                <input
                    ref={inputRef}
                    type="text"
                    value={editorState.visibleValue}
                    onChange={(event) => updateVisibleValue(event.target.value, !isComposingRef.current)}
                    onCompositionStart={() => {
                        isComposingRef.current = true;
                    }}
                    onCompositionEnd={(event) => {
                        isComposingRef.current = false;
                        updateVisibleValue(event.currentTarget.value, true);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' && suggestions.length > 0) {
                            event.preventDefault();
                            setActiveSuggestionIndex(index => (index + 1) % suggestions.length);
                            return;
                        }
                        if (event.key === 'ArrowUp' && suggestions.length > 0) {
                            event.preventDefault();
                            setActiveSuggestionIndex(index => (index - 1 + suggestions.length) % suggestions.length);
                            return;
                        }
                        if (event.key === 'Tab' && suggestions[activeSuggestionIndex]) {
                            event.preventDefault();
                            onDraftChange(suggestions[activeSuggestionIndex].completedQuery, false);
                            return;
                        }
                        if (event.key === 'Enter' && isSyntaxMode) {
                            event.preventDefault();
                            const completedQuery = suggestions[activeSuggestionIndex]?.completedQuery || draftQuery;
                            onDraftChange(completedQuery, false);
                            applyQuery(completedQuery);
                            return;
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            onDismiss();
                        }
                    }}
                    placeholder={isSyntaxMode
                        ? t(editorState.operator === 'path'
                            ? 'home.gridQueryExactPathPlaceholder'
                            : editorState.operator === 'under'
                                ? 'home.gridQuerySubtreePlaceholder'
                                : 'home.gridQueryPlaceholder')
                        : `${t('home.gridSearchPlaceholder')} (/)`}
                    className="min-w-0 flex-1 bg-transparent py-3 text-sm font-medium outline-none placeholder:text-current placeholder:opacity-40"
                    style={{ color: 'var(--text-primary)' }}
                />
                {isSyntaxMode && (
                    <button
                        type="button"
                        onClick={() => applyQuery()}
                        disabled={!parsedQuery.valid || !isDirty}
                        className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 text-[10px] font-semibold transition-colors hover:bg-white/15 disabled:opacity-30"
                        title={t('home.gridQueryApply')}
                    >
                        <Check size={12} />
                        {t('home.gridQueryApply')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => {
                        if (draftQuery || appliedQuery) {
                            onClear();
                            requestAnimationFrame(() => inputRef.current?.focus());
                        } else {
                            onDismiss();
                        }
                    }}
                    className="shrink-0 rounded-full p-1.5 opacity-45 transition-opacity hover:opacity-90"
                    aria-label={draftQuery || appliedQuery ? t('ui.clear') : t('ui.close')}
                >
                    <X size={15} />
                </button>
            </div>

            {isSyntaxMode && suggestions.length > 0 && (
                <div className="border-t border-white/10 p-2">
                    {suggestions.map((suggestion, index) => (
                        <button
                            key={suggestion.id}
                            type="button"
                            onMouseEnter={() => setActiveSuggestionIndex(index)}
                            onClick={() => {
                                onDraftChange(suggestion.completedQuery, false);
                                requestAnimationFrame(() => inputRef.current?.focus());
                            }}
                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                                index === activeSuggestionIndex ? 'bg-white/10' : 'hover:bg-white/5'
                            }`}
                        >
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-semibold">{suggestion.label}</span>
                                <span className="block truncate text-[10px] opacity-45">
                                    {suggestion.kind === 'command'
                                        ? t(suggestion.label === 'path' ? 'home.gridQueryPathHint' : 'home.gridQueryUnderHint')
                                        : suggestion.detail || t('home.gridQueryPathSuggestion')}
                                </span>
                            </span>
                            {index === activeSuggestionIndex && <CornerDownLeft size={13} className="shrink-0 opacity-35" />}
                        </button>
                    ))}
                </div>
            )}

            {isSyntaxMode && !parsedQuery.valid && suggestions.length === 0 && (
                <div className="border-t border-white/10 px-4 py-2 text-[10px] text-amber-500">
                    {t(parsedQuery.error === 'unterminated-quote'
                        ? 'home.gridQueryUnterminatedQuote'
                        : 'home.gridQueryMissingArgument')}
                </div>
            )}
        </div>
    );
};

export default GridMapSearchPanel;
