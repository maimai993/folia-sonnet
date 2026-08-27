import { Timer } from 'lucide-react';
import { defineCommand } from '../commandFactories';
import { sleepTimerSurface } from '../surfaces/sleepTimerSurface';
import type { CommandPaletteCommand } from '../types';

// src/components/command-palette/commands/sleepTimerCommand.ts

export const sleepTimerCommand: CommandPaletteCommand = defineCommand({
    id: 'sleep-timer',
    group: 'settings',
    title: 'Sleep timer',
    description: 'Close the app after a chosen duration',
    keywords: ['sleep timer', 'auto close', 'auto quit', 'shutdown timer', '定时关闭', '睡眠定时', '自动关闭', '到时关闭', '倒计时退出', 'dingshiguanbi', 'shuimiandingshi', 'zidongguanbi', 'daoshiguanbi', 'dsgb', 'smds', 'zdgb'],
    icon: Timer,
    surface: sleepTimerSurface,
    requiresInput: true,
    execute: () => true,
});
