import React from 'react';
import { Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { useScreenAwakeSettingsStore } from '../../../stores/useScreenAwakeSettingsStore';

// Android-only 屏幕常亮 switch. It lives in the interface settings because it is a device behaviour
// rather than a playback one; the playback subview keeps its narrower "only while playing" variant.

type AndroidScreenAwakeSettingProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    theme?: { secondaryColor?: string } | null;
};

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

const AndroidScreenAwakeSetting: React.FC<AndroidScreenAwakeSettingProps> = ({
    isDaylight,
    settingsCardClass,
    theme,
}) => {
    const { t } = useTranslation();
    const enabled = useScreenAwakeSettingsStore(state => state.keepScreenAwake);
    const setEnabled = useScreenAwakeSettingsStore(state => state.setKeepScreenAwake);

    if (!isAndroidNativeRuntime()) return null;

    const toggleOffBackgroundClass = isDaylight ? 'bg-zinc-200' : 'bg-[#2A2D35]';

    return (
        <div className="space-y-4">
            <SettingsSectionHeading icon={Sun} label={t('options.screenAwakeSection')} />
            <div className={`p-4 rounded-xl border ${settingsCardClass}`}>
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('options.keepScreenAwake')}
                        </div>
                        <div className="text-xs opacity-50 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.keepScreenAwakeDesc')}
                        </div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={t('options.keepScreenAwake')}
                        onClick={() => setEnabled(!enabled)}
                        className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 ${!enabled ? toggleOffBackgroundClass : ''}`}
                        style={{ backgroundColor: enabled ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                    >
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-6' : 'translate-x-0'}`} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AndroidScreenAwakeSetting;
