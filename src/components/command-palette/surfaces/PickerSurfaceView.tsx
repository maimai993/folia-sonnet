import React, { useEffect, useRef } from 'react';
import { AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme, VisualizerBackgroundMode, VisualizerMode } from '../../../types';
import { BackgroundModeGlyph, VisualizerModeGlyph } from '../../visualizer/modeGlyphs';
import { readPickerMode } from '../commands/pickerOptions';
import { PICKER_GRID_COLUMNS } from './pickerSurface';
import type { CommandPaletteMatch } from '../types';

// src/components/command-palette/surfaces/PickerSurfaceView.tsx
// Icon grid for the visualizer and background pickers. Tiles reuse the same mode glyphs the
// player panel's mode stepper draws, so a mode looks identical wherever it is offered; unknown
// modes fall back inside the glyph components, so a newly discovered mode still renders.

type PickerSurfaceViewProps = {
    kind: 'visualizer' | 'background';
    matches: CommandPaletteMatch[];
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    executeMatch: (index: number) => Promise<boolean>;
    isDaylight: boolean;
    isExecuting: boolean;
    theme: Theme;
};

const PickerSurfaceView: React.FC<PickerSurfaceViewProps> = ({
    kind,
    matches,
    activeIndex,
    setActiveIndex,
    executeMatch,
    isDaylight,
    isExecuting,
    theme,
}) => {
    const { t } = useTranslation();
    const activeTileRef = useRef<HTMLButtonElement | null>(null);

    // Arrow keys move activeIndex through the shared match pipeline, so the grid only has to
    // keep the highlighted tile in view.
    useEffect(() => {
        activeTileRef.current?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    if (matches.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center opacity-50">
                <AudioLines size={26} />
                <div className="text-sm">{t('commandPalette.empty', 'No matching command')}</div>
            </div>
        );
    }

    return (
        <div
            className="grid gap-2 p-1"
            style={{ gridTemplateColumns: `repeat(${PICKER_GRID_COLUMNS}, minmax(0, 1fr))` }}
        >
            {matches.map((match, index) => {
                const isActive = index === activeIndex;
                const mode = readPickerMode(kind, match.command.id);
                return (
                    <button
                        key={match.command.id}
                        ref={isActive ? activeTileRef : undefined}
                        type="button"
                        data-picker-mode={mode}
                        data-picker-active={isActive ? 'true' : 'false'}
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
                        className={`flex flex-col items-center gap-2 rounded-2xl border px-3 py-4 transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                            isActive
                                ? (isDaylight ? 'bg-black/10' : 'bg-white/10')
                                : (isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/5')
                        }`}
                        style={{ borderColor: isDaylight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)' }}
                    >
                        <span
                            className="flex h-10 w-10 items-center justify-center rounded-full border"
                            style={{
                                borderColor: isDaylight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)',
                                color: theme.accentColor,
                            }}
                        >
                            {kind === 'visualizer'
                                ? <VisualizerModeGlyph mode={mode as VisualizerMode} size={18} />
                                : <BackgroundModeGlyph mode={mode as VisualizerBackgroundMode} size={18} />}
                        </span>
                        <span className="w-full truncate text-center text-xs font-medium">{match.command.title}</span>
                    </button>
                );
            })}
        </div>
    );
};

export default PickerSurfaceView;
