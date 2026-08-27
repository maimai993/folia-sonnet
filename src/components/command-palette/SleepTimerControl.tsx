import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types';
import { DioramaSettingsToggle } from '../visualizer/diorama/DioramaSettingsToggle';

// src/components/command-palette/SleepTimerControl.tsx

type SleepTimerControlProps = {
    isDaylight: boolean;
    theme: Theme;
    enabled: boolean;
    hours: number;
    minutes: number;
    deadlineMs: number | null;
    onEnabledChange: (enabled: boolean) => void;
    onHoursChange: (hours: number) => void;
    onMinutesChange: (minutes: number) => void;
};

const formatRemaining = (remainingMs: number) => {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

type NumberFieldProps = {
    isDaylight: boolean;
    label: string;
    max: number;
    value: number;
    onChange: (next: number) => void;
};

// Numeric field that blocks illegal input: everything but digits is stripped, and any value
// above `max` is refused (the field keeps its previous value).
const SleepTimerNumberField: React.FC<NumberFieldProps> = ({ isDaylight, label, max, value, onChange }) => {
    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const digits = event.currentTarget.value.replace(/\D/g, '');
        if (digits === '') {
            onChange(0);
            return;
        }
        const next = Number(digits);
        if (next > max) {
            return;
        }
        onChange(next);
    };

    return (
        <input
            type="text"
            inputMode="numeric"
            maxLength={max > 99 ? 3 : 2}
            value={String(value)}
            onChange={handleChange}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={label}
            className={`w-16 rounded-lg border px-3 py-2 text-center text-sm outline-none transition-colors ${isDaylight
                ? 'border-black/10 bg-white/60 text-zinc-900'
                : 'border-white/10 bg-black/40 text-white'
                }`}
        />
    );
};

const SleepTimerControl: React.FC<SleepTimerControlProps> = ({
    isDaylight,
    theme,
    enabled,
    hours,
    minutes,
    deadlineMs,
    onEnabledChange,
    onHoursChange,
    onMinutesChange,
}) => {
    const { t } = useTranslation();
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!enabled || deadlineMs === null) {
            return;
        }
        const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
        return () => window.clearInterval(timer);
    }, [deadlineMs, enabled]);

    const remainingMs = enabled && deadlineMs !== null ? Math.max(0, deadlineMs - Date.now()) : null;
    const hint = !enabled
        ? t('commandPalette.sleepTimerDisabledHint', 'Turn it on to schedule an auto close')
        : hours === 0 && minutes === 0
            ? t('commandPalette.sleepTimerZeroHint', '0h 0m never closes the app; pick a duration above')
            : t('commandPalette.sleepTimerCountdownHint', 'Closing in {{time}}')
                .replace('{{time}}', formatRemaining(remainingMs ?? (hours * 3600 + minutes * 60) * 1000));

    return (
        <div className="flex h-full items-center justify-center px-4 py-10">
            <div className="w-full max-w-lg px-6 py-7">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <Timer size={22} style={{ color: theme.accentColor }} />
                        <div>
                            <div className="text-sm font-medium">{t('commandPalette.sleepTimerTitle', 'Sleep timer')}</div>
                            <div className="mt-0.5 max-w-[240px] truncate text-xs tabular-nums opacity-50">{hint}</div>
                        </div>
                    </div>
                    <DioramaSettingsToggle
                        checked={enabled}
                        label={t('commandPalette.sleepTimerTitle', 'Sleep timer')}
                        onChange={onEnabledChange}
                        theme={theme}
                        isDaylight={isDaylight}
                    />
                </div>

                <div className="flex items-center justify-center gap-3">
                    <SleepTimerNumberField
                        isDaylight={isDaylight}
                        label={t('commandPalette.sleepTimerHoursLabel', 'Hours')}
                        max={999}
                        value={hours}
                        onChange={onHoursChange}
                    />
                    <span className={`text-sm font-semibold ${isDaylight ? 'text-black/50' : 'text-white/50'}`}>h</span>
                    <SleepTimerNumberField
                        isDaylight={isDaylight}
                        label={t('commandPalette.sleepTimerMinutesLabel', 'Minutes')}
                        max={59}
                        value={minutes}
                        onChange={onMinutesChange}
                    />
                    <span className={`text-sm font-semibold ${isDaylight ? 'text-black/50' : 'text-white/50'}`}>min</span>
                </div>
            </div>
        </div>
    );
};

export default SleepTimerControl;
