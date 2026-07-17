import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
    DIORAMA_BACKGROUND_PARTICLE_DENSITY_MAX,
    DIORAMA_BACKGROUND_PARTICLE_DENSITY_MIN,
    DIORAMA_BACKGROUND_PARTICLE_DENSITY_STEP,
    type Theme,
} from '../../../types';
import { colorWithAlpha } from '../colorMix';
import { DioramaSettingsToggle } from './DioramaSettingsToggle';

// src/components/visualizer/diorama/DioramaBackgroundParticleSettings.tsx
// Collapsible controls for the background dust layer, matching the follow-sing effect groups.
interface DioramaBackgroundParticleSettingsProps {
    label: string;
    enabled: boolean;
    density: number;
    onEnabledChange: (next: boolean) => void;
    onDensityChange: (next: number) => void;
    t: (key: string) => string;
    isDaylight: boolean;
    theme: Theme;
    rangeInputClass: string;
    onSliderPointerDown?: () => void;
    onSliderCommit?: () => void;
}

export const DioramaBackgroundParticleSettings: React.FC<DioramaBackgroundParticleSettingsProps> = ({
    label,
    enabled,
    density,
    onEnabledChange,
    onDensityChange,
    t,
    isDaylight,
    theme,
    rangeInputClass,
    onSliderPointerDown,
    onSliderCommit,
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const controlsId = useId();
    const densityLabel = t('options.dioramaBackgroundParticleDensity') || '粒子密度';
    // Shown as a share of the cap rather than a raw count: the number that matters to the user is "how
    // far up the safe range am I", and the cap itself is not a thing they can move.
    const percent = Math.round(
        ((density - DIORAMA_BACKGROUND_PARTICLE_DENSITY_MIN)
            / (DIORAMA_BACKGROUND_PARTICLE_DENSITY_MAX - DIORAMA_BACKGROUND_PARTICLE_DENSITY_MIN)) * 100,
    );

    return (
        <fieldset className="space-y-2.5">
            <legend className="sr-only">{label}</legend>
            <div
                className="flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-3"
                style={{
                    borderColor: colorWithAlpha(theme.secondaryColor, isDaylight ? 0.17 : 0.14),
                    backgroundColor: colorWithAlpha(theme.backgroundColor, isDaylight ? 0.24 : 0.34),
                }}
            >
                <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-controls={controlsId}
                    onClick={() => setIsExpanded(expanded => !expanded)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                    <ChevronDown
                        size={16}
                        aria-hidden="true"
                        className={`shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        style={{ color: 'var(--text-secondary)' }}
                    />
                    <span className="min-w-0">
                        <span className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {label}
                        </span>
                    </span>
                </button>
                <DioramaSettingsToggle
                    checked={enabled}
                    label={label}
                    onChange={onEnabledChange}
                    theme={theme}
                    isDaylight={isDaylight}
                />
            </div>

            {isExpanded && (
                <div
                    id={controlsId}
                    className="ml-3 space-y-2 border-l pl-3"
                    style={{ borderColor: colorWithAlpha(theme.accentColor, enabled ? 0.3 : 0.12) }}
                >
                    <div className="flex items-center justify-between gap-3 text-sm">
                        <div className="min-w-0" style={{ color: 'var(--text-primary)' }}>{densityLabel}</div>
                        <span className="shrink-0 font-mono opacity-70" style={{ color: 'var(--text-secondary)' }}>
                            {percent}%
                        </span>
                    </div>
                    <input
                        type="range"
                        min={DIORAMA_BACKGROUND_PARTICLE_DENSITY_MIN}
                        max={DIORAMA_BACKGROUND_PARTICLE_DENSITY_MAX}
                        step={DIORAMA_BACKGROUND_PARTICLE_DENSITY_STEP}
                        value={density}
                        disabled={!enabled}
                        aria-label={`${label} ${densityLabel}`}
                        onChange={(event) => onDensityChange(parseFloat(event.target.value))}
                        onPointerDown={onSliderPointerDown}
                        onPointerUp={onSliderCommit}
                        className={`${rangeInputClass} disabled:cursor-not-allowed disabled:opacity-35`}
                    />
                </div>
            )}
        </fieldset>
    );
};
