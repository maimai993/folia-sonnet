import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Command, CornerDownLeft, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types';
import type { CommandPaletteMatch } from './types';

// src/components/command-palette/CommandPalette.tsx
// Full-screen command input overlay with autocomplete and keyboard execution.

type CommandPaletteProps = {
    activeIndex: number;
    activePreview: string | null;
    isDaylight: boolean;
    isComposing: boolean;
    isOpen: boolean;
    matches: CommandPaletteMatch[];
    query: string;
    theme: Theme;
    onActiveIndexChange: (index: number) => void;
    onClose: () => void;
    onCompositionEnd: (query: string) => void;
    onCompositionStart: () => void;
    onExecuteActive: () => Promise<boolean>;
    onExecuteMatch: (index: number) => Promise<boolean>;
    onQueryChange: (query: string) => void;
};

const groupLabelKey: Record<string, string> = {
    search: 'commandPalette.groupSearch',
    settings: 'commandPalette.groupSettings',
    navigation: 'commandPalette.groupNavigation',
    panel: 'commandPalette.groupPanel',
    playback: 'commandPalette.groupPlayback',
    visualizer: 'commandPalette.groupVisualizer',
};

const CommandPalette: React.FC<CommandPaletteProps> = ({
    activeIndex,
    activePreview,
    isDaylight,
    isComposing,
    isOpen,
    matches,
    query,
    theme,
    onActiveIndexChange,
    onClose,
    onCompositionEnd,
    onCompositionStart,
    onExecuteActive,
    onExecuteMatch,
    onQueryChange,
}) => {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const panelBg = isDaylight ? 'bg-white/90 text-zinc-950' : 'bg-zinc-950/90 text-white';
    const itemActiveBg = isDaylight ? 'bg-black/10' : 'bg-white/10';
    const itemIdleBg = isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/5';

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            inputRef.current?.focus();
        });

        return () => window.cancelAnimationFrame(frame);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }

            if (event.isComposing || isComposing) {
                return;
            }

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                onActiveIndexChange(Math.min(matches.length - 1, activeIndex + 1));
                return;
            }

            if (event.key === 'ArrowUp') {
                event.preventDefault();
                onActiveIndexChange(Math.max(0, activeIndex - 1));
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                void onExecuteActive();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeIndex, isOpen, matches.length, onActiveIndexChange, onClose, onExecuteActive]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="fixed inset-0 z-[150] flex items-start justify-center px-4 pt-[18vh] backdrop-blur-md"
                    style={{ backgroundColor: isDaylight ? 'rgba(250,250,249,0.46)' : 'rgba(0,0,0,0.48)' }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    onMouseDown={onClose}
                >
                    <motion.div
                        className={`w-full max-w-2xl overflow-hidden rounded-3xl border shadow-2xl backdrop-blur-2xl ${panelBg}`}
                        style={{
                            borderColor: isDaylight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)',
                            color: 'var(--text-primary)',
                        }}
                        initial={{ opacity: 0, y: 18, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 18, scale: 0.98 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: isDaylight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)' }}>
                            <Search size={18} className="opacity-45" />
                            <input
                                ref={inputRef}
                                type="text"
                                value={query}
                                onChange={(event) => onQueryChange(event.target.value)}
                                onCompositionStart={onCompositionStart}
                                onCompositionEnd={(event) => onCompositionEnd(event.currentTarget.value)}
                                placeholder={t('commandPalette.placeholder') || 'Type a command or search...'}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                name="folia-command-palette-query"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-expanded={matches.length > 0}
                                className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:opacity-45"
                                style={{ color: 'var(--text-primary)' }}
                            />
                            <button
                                type="button"
                                onClick={onClose}
                                className={`rounded-full p-2 transition-colors ${isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/10'}`}
                                aria-label={t('commandPalette.close') || 'Close command palette'}
                            >
                                <X size={16} />
                            </button>
                        </div>

                        {activePreview && (
                            <div
                                className="border-b px-4 py-3 text-sm"
                                style={{ borderColor: isDaylight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)' }}
                            >
                                <span className="mr-2 text-xs uppercase tracking-[0.12em] opacity-45">
                                    {t('commandPalette.recognized') || 'Recognized'}
                                </span>
                                <span className="font-medium">{activePreview}</span>
                            </div>
                        )}

                        <div className="max-h-[50vh] overflow-y-auto p-2">
                            {matches.length === 0 ? (
                                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center opacity-50">
                                    <Command size={26} />
                                    <div className="text-sm">{t('commandPalette.empty') || 'No matching command'}</div>
                                </div>
                            ) : (
                                matches.map((match, index) => {
                                    const isActive = index === activeIndex;
                                    const groupLabel = t(groupLabelKey[match.command.group] || 'commandPalette.groupOther') || match.command.group;
                                    const title = t(`commandPalette.commands.${match.command.id}.title`, match.command.title);
                                    const description = t(`commandPalette.commands.${match.command.id}.description`, match.command.description);
                                    const commandHint = match.command.keywords[0] ?? match.command.id;
                                    return (
                                        <button
                                            key={match.command.id}
                                            type="button"
                                            onMouseEnter={() => onActiveIndexChange(index)}
                                            onClick={() => {
                                                onActiveIndexChange(index);
                                                if (match.command.requiresInput && !match.input) {
                                                    const nextQuery = `${commandHint} `;
                                                    onQueryChange(nextQuery);
                                                    window.requestAnimationFrame(() => {
                                                        inputRef.current?.focus();
                                                        inputRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
                                                    });
                                                    return;
                                                }
                                                void onExecuteMatch(index);
                                            }}
                                            className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${isActive ? itemActiveBg : itemIdleBg}`}
                                        >
                                            <div
                                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
                                                style={{
                                                    borderColor: isDaylight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)',
                                                    color: theme.accentColor,
                                                }}
                                            >
                                                <Command size={16} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="truncate text-sm font-medium">{title}</span>
                                                    <span
                                                        className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                                                            isDaylight ? 'bg-black/8 text-zinc-700' : 'bg-white/10 text-zinc-200'
                                                        }`}
                                                    >
                                                        {commandHint}
                                                    </span>
                                                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] opacity-50">
                                                        {groupLabel}
                                                    </span>
                                                </div>
                                                <div className="mt-0.5 truncate text-xs opacity-50">
                                                    {description}
                                                </div>
                                            </div>
                                            {isActive && (
                                                <div className="hidden items-center gap-1 text-xs opacity-45 sm:flex">
                                                    <CornerDownLeft size={13} />
                                                    {t('commandPalette.run') || 'Run'}
                                                </div>
                                            )}
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default CommandPalette;
