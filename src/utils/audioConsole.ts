import { normalizeAudioConsoleSettings } from './audioConsole/normalize';
import type { AudioConsoleSettings } from './audioConsole/model';

// src/utils/audioConsole.ts
// 调音台的模型层：混响、压缩器、前置/后置 EQ 的形状参数。
//
// 与 audioEqualizer.ts 的分工：那边管的是**十段增益本身**（含预设、自定义槽位、mod 曲线），
// 这份文件管的是「这些增益怎么被用」以及另外三块处理。分开存有两个好处：
//   1. 老的存储键（audio_equalizer_settings）一个字节都不用动，升级不会让用户丢设置；
//   2. mod 曲线只作用于十段增益，不会连带把压缩器和混响也改掉 —— 那是两件事。
//
// 存的是「用户的选择」，不是「此刻的声音」：所有字段都是可读的物理量
// （秒、dB、比率、毫秒），原生侧照着算就行，不需要在这里预先算系数。

export const AUDIO_CONSOLE_STORAGE_KEY = 'folia_audio_console';

export * from './audioConsole/model';
export * from './audioConsole/defaults';
export * from './audioConsole/normalize';
export * from './audioConsole/compressorCurve';
export * from './audioConsole/impulse';

export const readStoredAudioConsoleSettings = (): AudioConsoleSettings => {
    if (typeof window === 'undefined') return normalizeAudioConsoleSettings(null);
    try {
        const raw = window.localStorage.getItem(AUDIO_CONSOLE_STORAGE_KEY);
        return normalizeAudioConsoleSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return normalizeAudioConsoleSettings(null);
    }
};

export const writeStoredAudioConsoleSettings = (settings: AudioConsoleSettings) => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(AUDIO_CONSOLE_STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // 存不下（隐私模式配额）不该让界面崩：这一份只在这次会话里有效。
    }
};

/** 参数是否一样：store 用它在拖动结束时判「要不要落盘」，推原生也用它去重。 */
export const areAudioConsoleSettingsEqual = (left: AudioConsoleSettings, right: AudioConsoleSettings): boolean => (
    JSON.stringify(left) === JSON.stringify(right)
);
