import type { CommandPaletteSurface } from './types';

// src/components/command-palette/surfaces/sleepTimerSurface.ts

export const sleepTimerSurface: CommandPaletteSurface = {
    load: () => import('./SleepTimerSurfaceView'),
    mapProps: ({ context, isDaylight, theme }) => ({
        isDaylight,
        theme,
        enabled: context.settings.sleepTimerEnabled,
        hours: context.settings.sleepTimerHours,
        minutes: context.settings.sleepTimerMinutes,
        deadlineMs: context.settings.sleepTimerDeadlineMs,
        onEnabledChange: context.settings.setSleepTimerEnabled,
        onHoursChange: context.settings.setSleepTimerHours,
        onMinutesChange: context.settings.setSleepTimerMinutes,
    }),
};
