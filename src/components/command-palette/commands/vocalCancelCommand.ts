import { MicOff } from 'lucide-react';
import { defineCommand } from '../commandFactories';
import type { CommandPaletteCommand } from '../types';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';

// src/components/command-palette/commands/vocalCancelCommand.ts
// 关闭人声（中置相消）的开关命令。
//
// 它同时是音质页那颗开关的另一条入口：设置页和命令面板读的都是同一个 store 字段，
// 所以两处永远一致。只在安卓出现 —— 它靠原生 AudioSink 的处理链实时做
// （player/dsp/VocalCancelProcessor.kt），桌面端那条链不存在。

export const vocalCancelCommand: CommandPaletteCommand = defineCommand({
    id: 'audio-vocal-cancel',
    group: 'settings',
    title: 'Remove vocals',
    description: 'Strip the centre-panned vocal in real time, leaving the accompaniment',
    keywords: ['vocal cancel', 'karaoke', 'instrumental', 'accompaniment', '关闭人声', '伴奏', '消音', '去人声'],
    icon: MicOff,
    // 没有那条音频链的构建里不出现，而不是出现一条点了没反应的命令。
    platform: ['capacitor-android'],
    execute: () => {
        const { vocalCancelEnabled, handleToggleVocalCancel } = useAudioSettingsStore.getState();
        handleToggleVocalCancel(!vocalCancelEnabled);
        return true;
    },
});
