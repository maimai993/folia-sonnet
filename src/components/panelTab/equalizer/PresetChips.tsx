import React from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioEqualizerModeId } from '../../../utils/audioEqualizer';
import PanelIconButton from '../shell/PanelIconButton';
import { Button } from '../../ui';

// src/components/panelTab/equalizer/PresetChips.tsx
// The presets of the audio effect window: a line of chips that wraps, the chosen one in the accent
// colour, and at its right end the button that clears the chosen custom slot.

type PresetChipsProps = {
    presetIds: readonly AudioEqualizerModeId[];
    /** Null while a mod's curve plays: no chip is lit, and choosing one is the listener's choice that ends it. */
    chosen: AudioEqualizerModeId | null;
    onChoose: (presetId: AudioEqualizerModeId) => void;
    /** False while a built-in preset is chosen: there is nothing to clear, and the button is dimmed. */
    canReset: boolean;
    onReset: () => void;
};

const PresetChips: React.FC<PresetChipsProps> = ({ presetIds, chosen, onChoose, canReset, onReset }) => {
    const { t } = useTranslation();

    return (
        <div className="flex items-start gap-2">
            {/* 宽窗里预设换行排成两三行，一眼看全；手机上那样会占掉近百像素，把十段推子挤到
                屏幕外，所以窄窗改成一行横向滚动 —— 滚动条藏起来，右边缘的截断本身就是「还有」。 */}
            <div className="flex flex-1 flex-wrap gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-0.5 max-sm:[scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,transparent_0,black_20px,black_calc(100%-20px),transparent_100%)] max-sm:[&::-webkit-scrollbar]:hidden">
                {presetIds.map(presetId => (
                    <Button
                        key={presetId}
                        onClick={() => onChoose(presetId)}
                        aria-pressed={chosen === presetId}
                        className={`st-t-fast h-7 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] transition-[background-color,color,scale] active:scale-[0.96] ${chosen === presetId
                            ? 'bg-[var(--st-accent)] text-[color:var(--st-on-accent)]'
                            : 'bg-[var(--st-fill)] text-[color:var(--st-t2)] hover:bg-[var(--st-fill2)] hover:text-[color:var(--st-t1)]'}`}
                    >
                        {t(`ui.equalizerPreset.${presetId}`)}
                    </Button>
                ))}
            </div>
            <PanelIconButton label={t('ui.equalizerReset')} disabled={!canReset} onClick={onReset}>
                <RotateCcw size={16} />
            </PanelIconButton>
        </div>
    );
};

export default PresetChips;
