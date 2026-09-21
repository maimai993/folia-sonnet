import React from 'react';
import { GraduationCap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { selectPonderSettingsSnapshot, usePonderStore } from '../../../stores/usePonderStore';
import { PONDER_HINT_VISIBILITY_VALUES, type PonderHintVisibility } from '../../../types/ponder';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';

// src/components/modal/settings/PonderHintSettingsSection.tsx
// 思索教程提示的三档可见性。
//
// 独立成文件而不是塞进 LabSettingsModal：那个文件已经 400 多行，而 file-modularization 说
// 一次往既有文件加 80 行以上就该建模块。渲染在实验室面板里，锚点照样被 settingsAnchorCoverage
// 扫到（它只看 settings/ 这一层的 *.tsx）。
//
// renderToggle 是两态的，套不上三档，所以这里自己画一组分段按钮。

const LABEL_KEYS: Record<PonderHintVisibility, string> = {
    always: 'options.ponderHintsAlways',
    unseen: 'options.ponderHintsUnseen',
    off: 'options.ponderHintsOff',
};

type PonderHintSettingsSectionProps = {
    settingsCardClass: string;
    isDaylight: boolean;
    accentColor?: string;
};

const PonderHintSettingsSection: React.FC<PonderHintSettingsSectionProps> = ({
    settingsCardClass,
    isDaylight,
    accentColor,
}) => {
    const { t } = useTranslation();
    const { ponderHintVisibility, setPonderHintVisibility } = usePonderStore(
        useShallow(selectPonderSettingsSnapshot),
    );

    const idleClass = isDaylight ? 'hover:bg-black/[0.06]' : 'hover:bg-white/[0.08]';

    return (
        <SettingsAnchor anchorId="labPonder" label={t('options.ponderHints')} className="space-y-4">
            <SettingsSectionHeading icon={GraduationCap} label={t('options.ponderHints')} divider />

            <div className={`p-4 rounded-xl border space-y-3 ${settingsCardClass}`}>
                <div className="space-y-1">
                    <div className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <GraduationCap size={14} />
                        {t('options.ponderHints')}
                    </div>
                    <div className="text-xs opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.ponderHintsDesc')}
                    </div>
                </div>

                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('options.ponderHints')}>
                    {PONDER_HINT_VISIBILITY_VALUES.map(value => {
                        const isActive = ponderHintVisibility === value;
                        return (
                            <button
                                key={value}
                                type="button"
                                role="radio"
                                aria-checked={isActive}
                                onClick={() => setPonderHintVisibility(value)}
                                className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${isActive ? '' : idleClass}`}
                                style={isActive
                                    ? { backgroundColor: accentColor || (isDaylight ? '#27272a' : '#fafafa'), color: isDaylight ? '#fafafa' : '#18181b' }
                                    : { color: 'var(--text-secondary)' }}
                            >
                                {t(LABEL_KEYS[value])}
                            </button>
                        );
                    })}
                </div>
            </div>
        </SettingsAnchor>
    );
};

export default PonderHintSettingsSection;
