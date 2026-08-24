import React, { useEffect, useRef } from 'react';
import { AudioLines, Check, LayoutGrid, Wallpaper } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme, VisualizerBackgroundMode, VisualizerMode } from '../../../types';
import { BackgroundModeGlyph, VisualizerModeGlyph } from '../../visualizer/modeGlyphs';
import { getPickerModeLabel, readPickerMode } from '../commands/pickerOptions';
import type { CommandPaletteMatch } from '../types';

// src/components/command-palette/surfaces/PickerSurfaceView.tsx
// Visualizer and background pickers, wearing the same shell as the volume and FM surfaces: a
// header stating the mode that is live right now, then the control. Each row is glyph, name, and
// what the mode does; the glyphs are the ones the player panel's mode stepper draws, so a mode
// looks identical wherever it is offered, and unknown modes fall back inside the glyph components.

type PickerSurfaceViewProps = {
    kind: 'visualizer' | 'background';
    matches: CommandPaletteMatch[];
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    executeMatch: (index: number) => Promise<boolean>;
    isDaylight: boolean;
    isExecuting: boolean;
    theme: Theme;
    currentMode: string;
};

const HEADER = {
    visualizer: { icon: LayoutGrid, commandId: 'visualizer-picker', title: 'Pick a visualizer', hint: 'Browse lyric animation modes and click one to switch' },
    background: { icon: Wallpaper, commandId: 'background-picker', title: 'Pick a background', hint: 'Browse background layouts and click one to switch' },
} as const;

const PickerSurfaceView: React.FC<PickerSurfaceViewProps> = ({
    kind,
    matches,
    activeIndex,
    setActiveIndex,
    executeMatch,
    isDaylight,
    isExecuting,
    theme,
    currentMode,
}) => {
    const { t } = useTranslation();
    const translate = (key: string, fallback?: string) => t(key, { defaultValue: fallback ?? key });
    const activeRowRef = useRef<HTMLButtonElement | null>(null);

    // Arrow keys move activeIndex through the shared match pipeline, so the list only has to keep
    // the highlighted row in view.
    useEffect(() => {
        activeRowRef.current?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    if (matches.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center opacity-50">
                <AudioLines size={26} />
                <div className="text-sm">{t('commandPalette.empty', 'No matching command')}</div>
            </div>
        );
    }

    // Same backgrounds as the FM pills, so the pickers read as one control family.
    const idleBg = isDaylight ? 'hover:bg-black/[0.06]' : 'hover:bg-white/[0.08]';
    const activeBg = isDaylight ? 'bg-black/[0.08]' : 'bg-white/[0.12]';
    const header = HEADER[kind];
    const HeaderIcon = header.icon;

    return (
        <div className="flex h-full items-start justify-center px-4 py-6">
            <div className="w-full max-w-lg px-4">
                <div className="mb-4 flex items-center justify-between gap-4 px-3">
                    <div className="flex items-center gap-3">
                        <HeaderIcon size={22} style={{ color: theme.accentColor }} />
                        <div>
                            <div className="text-sm font-medium">
                                {translate(`commandPalette.commands.${header.commandId}.title`, header.title)}
                            </div>
                            <div className="mt-0.5 text-xs opacity-50">
                                {translate(`commandPalette.commands.${header.commandId}.description`, header.hint)}
                            </div>
                        </div>
                    </div>
                    <div className="truncate text-base font-semibold" style={{ color: theme.primaryColor }}>
                        {getPickerModeLabel(kind, currentMode, translate)}
                    </div>
                </div>

                <div className="flex flex-col gap-0.5">
                    {matches.map((match, index) => {
                        const isActive = index === activeIndex;
                        const mode = readPickerMode(kind, match.command.id);
                        const isSelected = mode === currentMode;
                        return (
                            <button
                                key={match.command.id}
                                ref={isActive ? activeRowRef : undefined}
                                type="button"
                                data-picker-mode={mode}
                                data-picker-active={isActive ? 'true' : 'false'}
                                data-picker-selected={isSelected ? 'true' : 'false'}
                                disabled={isExecuting}
                                onMouseEnter={() => {
                                    if (!isExecuting) {
                                        setActiveIndex(index);
                                    }
                                }}
                                onClick={() => {
                                    if (!isExecuting) {
                                        setActiveIndex(index);
                                        void executeMatch(index);
                                    }
                                }}
                                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                                    isActive ? activeBg : idleBg
                                }`}
                            >
                                <span
                                    className="flex shrink-0 items-center justify-center"
                                    style={{ color: theme.accentColor }}
                                >
                                    {kind === 'visualizer'
                                        ? <VisualizerModeGlyph mode={mode as VisualizerMode} size={18} />
                                        : <BackgroundModeGlyph mode={mode as VisualizerBackgroundMode} size={18} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className={`block truncate text-sm ${isSelected ? 'font-medium' : ''}`}>
                                        {match.command.title}
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs opacity-50">
                                        {match.command.description}
                                    </span>
                                </span>
                                {isSelected && (
                                    <Check size={16} className="shrink-0" style={{ color: theme.accentColor }} />
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default PickerSurfaceView;
