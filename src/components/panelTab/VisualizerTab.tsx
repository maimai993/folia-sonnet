import React from 'react';
import { motion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Theme, type CadenzeTuning, type VisualizerMode } from '../../types';

interface VisualizerTabProps {
    theme: Theme;
    isDaylight: boolean;
    visualizerMode: VisualizerMode;
    onVisualizerModeChange: (mode: VisualizerMode) => void;
    cadenzeTuning: CadenzeTuning;
    onCadenzeTuningChange: (patch: Partial<CadenzeTuning>) => void;
    onResetCadenzeTuning: () => void;
}

const sliderConfig: Array<{
    key: keyof CadenzeTuning;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
}> = [
    {
        key: 'fontScale',
        min: 0.8,
        max: 1.35,
        step: 0.01,
        format: value => `${value.toFixed(2)}x`,
    },
    {
        key: 'widthRatio',
        min: 0.5,
        max: 0.92,
        step: 0.01,
        format: value => `${Math.round(value * 100)}%`,
    },
    {
        key: 'motionAmount',
        min: 0,
        max: 1.8,
        step: 0.01,
        format: value => `${value.toFixed(2)}x`,
    },
    {
        key: 'glowIntensity',
        min: 0,
        max: 1.8,
        step: 0.01,
        format: value => `${value.toFixed(2)}x`,
    },
    {
        key: 'beamIntensity',
        min: 0,
        max: 1.8,
        step: 0.01,
        format: value => `${value.toFixed(2)}x`,
    },
];

const VisualizerTab: React.FC<VisualizerTabProps> = ({
    theme,
    isDaylight,
    visualizerMode,
    onVisualizerModeChange,
    cadenzeTuning,
    onCadenzeTuningChange,
    onResetCadenzeTuning,
}) => {
    const { t } = useTranslation();

    const wellBg = isDaylight ? 'bg-black/5' : 'bg-black/20';
    const activeOptionBg = isDaylight ? 'bg-white shadow-sm hover:bg-white/90' : 'bg-white/20 shadow-sm hover:bg-white/30';
    const subtleText = isDaylight ? 'text-black/45' : 'text-white/45';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
        >
            <div className="flex items-center justify-between">
                <div>
                    <div className="text-xs font-bold">{t('ui.visualizerWorkbench')}</div>
                    <div className={`text-[10px] uppercase tracking-widest ${subtleText}`}>
                        {t('ui.visualizerTemporary')}
                    </div>
                </div>
                <button
                    onClick={onResetCadenzeTuning}
                    className={`h-9 w-9 rounded-xl flex items-center justify-center transition-colors ${wellBg}`}
                    title={t('ui.resetVisualizerTuning')}
                >
                    <RotateCcw size={15} />
                </button>
            </div>

            <div>
                <div className="flex items-center justify-between mb-2">
                    <label className="text-[10px] font-bold opacity-40 uppercase tracking-widest">
                        {t('ui.visualizerMode')}
                    </label>
                    <span className="text-[10px] font-bold opacity-40 uppercase tracking-widest">
                        POC
                    </span>
                </div>
                <div className={`flex ${wellBg} p-1 rounded-xl`}>
                    <button
                        onClick={() => onVisualizerModeChange('classic')}
                        className={`flex-1 py-1.5 text-[10px] font-medium rounded-lg transition-all
                            ${visualizerMode === 'classic' ? activeOptionBg : 'opacity-40 hover:opacity-100'}`}
                    >
                        {t('ui.visualizerClassic')}
                    </button>
                    <button
                        onClick={() => onVisualizerModeChange('cadenze')}
                        className={`flex-1 py-1.5 text-[10px] font-medium rounded-lg transition-all
                            ${visualizerMode === 'cadenze' ? activeOptionBg : 'opacity-40 hover:opacity-100'}`}
                    >
                        {t('ui.visualizerCadenze')}
                    </button>
                </div>
            </div>

            <div className={`rounded-2xl ${wellBg} p-3 space-y-3`}>
                <div className="flex items-center justify-between">
                    <div className="text-[10px] font-bold uppercase tracking-widest opacity-40">
                        {t('ui.cadenzeTuning')}
                    </div>
                    <div className={`text-[10px] ${subtleText}`}>
                        {visualizerMode === 'cadenze' ? t('ui.livePreview') : t('ui.cadenzeOnly')}
                    </div>
                </div>

                {sliderConfig.map(item => (
                    <div key={item.key} className={visualizerMode === 'cadenze' ? '' : 'opacity-45'}>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-[11px] font-medium">
                                {t(`ui.cadenze.${item.key}`)}
                            </label>
                            <span className="text-[10px] opacity-60">
                                {item.format(cadenzeTuning[item.key])}
                            </span>
                        </div>
                        <input
                            type="range"
                            min={item.min}
                            max={item.max}
                            step={item.step}
                            value={cadenzeTuning[item.key]}
                            onChange={(event) => onCadenzeTuningChange({
                                [item.key]: parseFloat(event.currentTarget.value),
                            })}
                            disabled={visualizerMode !== 'cadenze'}
                            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-(--text-primary)"
                            style={{ accentColor: theme.primaryColor }}
                        />
                    </div>
                ))}
            </div>
        </motion.div>
    );
};

export default VisualizerTab;
