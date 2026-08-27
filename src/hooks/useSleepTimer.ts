import { useEffect } from 'react';
import { SLEEP_TIMER_ENABLED_STORAGE_KEY, useSettingsUiStore } from '../stores/useSettingsUiStore';

// src/hooks/useSleepTimer.ts

type UseSleepTimerState = {
    enabled: boolean;
    hours: number;
    minutes: number;
};

const TICK_MS = 1000;

export const useSleepTimer = ({ enabled, hours, minutes }: UseSleepTimerState) => {
    useEffect(() => {
        if (!enabled || (hours === 0 && minutes === 0)) {
            useSettingsUiStore.setState({ sleepTimerDeadlineMs: null });
            return;
        }

        const totalMs = (hours * 3600 + minutes * 60) * 1000;
        const deadline = Date.now() + totalMs;
        useSettingsUiStore.setState({ sleepTimerDeadlineMs: deadline });
        const timer = window.setInterval(() => {
            if (Date.now() >= deadline) {
                window.clearInterval(timer);
                localStorage.setItem(SLEEP_TIMER_ENABLED_STORAGE_KEY, 'false');
                useSettingsUiStore.setState({ sleepTimerDeadlineMs: null });
                void window.electron?.quitApp?.();
            }
        }, TICK_MS);

        return () => {
            window.clearInterval(timer);
            useSettingsUiStore.setState({ sleepTimerDeadlineMs: null });
        };
    }, [enabled, hours, minutes]);
};
