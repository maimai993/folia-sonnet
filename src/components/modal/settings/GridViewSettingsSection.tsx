import React from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import type { Theme } from '../../../types';
import {
    HEX_CARD_MIN_OPACITY_BOUNDS,
    HEX_CARD_MIN_OPACITY_DEFAULT,
    HEX_CARD_MIN_SCALE_BOUNDS,
    HEX_CARD_MIN_SCALE_DEFAULT,
} from '../../folia-grid/hexCardTransform';
import { useGridViewSettingsStore } from '../../../stores/useGridViewSettingsStore';

// src/components/modal/settings/GridViewSettingsSection.tsx
// Look of the folia card grid: full-bleed covers plus the two floors of the distance falloff.
// Reads the store directly, the way LatticeSettingsSection does, so AppearanceSettingsSubview does
// not grow another six props. Deliberately outside the appearance import/export payload.

type GridViewSettingsSectionProps = {
    settingsCardClass: string;
    toggleOffBackgroundClass: string;
    theme?: Theme;
};

const GridViewSettingsSection: React.FC<GridViewSettingsSectionProps> = ({
    settingsCardClass,
    toggleOffBackgroundClass,
    theme,
}) => {
    const { t } = useTranslation();
    const fullBleedCover = useGridViewSettingsStore(state => state.gridViewFullBleedCover);
    const minCardScale = useGridViewSettingsStore(state => state.gridViewMinCardScale);
    const minCardOpacity = useGridViewSettingsStore(state => state.gridViewMinCardOpacity);
    const setFullBleedCover = useGridViewSettingsStore(state => state.handleToggleGridViewFullBleedCover);
    const setMinCardScale = useGridViewSettingsStore(state => state.handleSetGridViewMinCardScale);
    const setMinCardOpacity = useGridViewSettingsStore(state => state.handleSetGridViewMinCardOpacity);
    const resetFalloff = useGridViewSettingsStore(state => state.resetGridViewCardFalloff);

    const isDefaultFalloff = minCardScale === HEX_CARD_MIN_SCALE_DEFAULT && minCardOpacity === HEX_CARD_MIN_OPACITY_DEFAULT;

    const renderSlider = (
        label: string,
        description: string,
        value: number,
        bounds: { min: number; max: number },
        onChange: (next: number) => void,
    ) => (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</div>
                    <div className="text-xs opacity-50 max-w-[360px]" style={{ color: 'var(--text-secondary)' }}>
                        {description}
                    </div>
                </div>
                <span className="font-mono text-xs shrink-0" style={{ color: 'var(--text-primary)' }}>
                    {Math.round(value * 100)}%
                </span>
            </div>
            <input
                type="range"
                min={bounds.min}
                max={bounds.max}
                step={0.01}
                value={value}
                onChange={event => onChange(Number(event.currentTarget.value))}
                className="w-full accent-current"
                style={{ accentColor: theme?.accentColor }}
                aria-label={label}
            />
        </div>
    );

    return (
        <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
            <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('options.gridViewFullBleedCover')}
                    </div>
                    <div className="text-xs opacity-50 max-w-[360px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.gridViewFullBleedCoverDesc')}
                    </div>
                </div>
                <button
                    onClick={() => setFullBleedCover(!fullBleedCover)}
                    className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!fullBleedCover ? toggleOffBackgroundClass : ''}`}
                    style={{ backgroundColor: fullBleedCover ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                    aria-pressed={fullBleedCover}
                    aria-label={t('options.gridViewFullBleedCover')}
                >
                    <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${fullBleedCover ? 'translate-x-6' : 'translate-x-0'}`} />
                </button>
            </div>

            <div className="border-t border-black/5 pt-4 space-y-4 dark:border-white/5">
                {renderSlider(
                    t('options.gridViewMinCardScale'),
                    t('options.gridViewMinCardScaleDesc'),
                    minCardScale,
                    HEX_CARD_MIN_SCALE_BOUNDS,
                    setMinCardScale,
                )}
                {renderSlider(
                    t('options.gridViewMinCardOpacity'),
                    t('options.gridViewMinCardOpacityDesc'),
                    minCardOpacity,
                    HEX_CARD_MIN_OPACITY_BOUNDS,
                    setMinCardOpacity,
                )}
                <button
                    type="button"
                    onClick={resetFalloff}
                    disabled={isDefaultFalloff}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-opacity hover:bg-current/10 disabled:cursor-default disabled:opacity-35"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <RotateCcw size={12} />
                    {t('options.gridViewCardFalloffReset')}
                </button>
            </div>
        </div>
    );
};

export default GridViewSettingsSection;
