import type { SonicBackgroundTuning } from '../../../../types';
import { DEFAULT_SONIC_BACKGROUND_TUNING } from '../../../../types';
import { defineBackgroundTuning, type StoredTuningFields } from '../../tuningDefinition';

// src/components/visualizer/backgrounds/sonic/tuning.ts
// 音域回响（Sonic Topography）的可调项。
//
// 那边的旋钮非常多（地形密度/范围/高低/景深/幅度/发光/平滑/锐利，外加 8 个频段的
// EQ 增益和配色），这里只挑真正影响观感、且不需要调音知识的几项：
// 密度、幅度、范围、高低、景深、发光、平滑、锐利。
//
// 8 个频段 EQ 不暴露 —— 那需要用户自己知道「presence 和 brilliance 的区别」，
// 而默认值是能直接用的。

declare module '../definition' {
    interface VisualizerBackgroundConfig {
        sonic?: BackgroundTuningSlot<SonicBackgroundTuning>;
    }
    interface VisualizerBackgroundActions {
        sonic?: BackgroundTuningActionSlot<SonicBackgroundTuning>;
    }
}

declare module '../../tuningDefinition' {
    interface VisualizerTuningSettings extends StoredTuningFields<'sonicBackgroundTuning', 'handleSetSonicBackgroundTuning', 'handleResetSonicBackgroundTuning', SonicBackgroundTuning> {}
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback
);

const resolveStoredSonicBackgroundTuning = (
    parsed: Partial<SonicBackgroundTuning>,
): SonicBackgroundTuning => {
    const defaults = DEFAULT_SONIC_BACKGROUND_TUNING;
    return {
        /*
         * 密度决定格数（平方增长），所以上下限卡得比别的项紧：
         * 32 已经看不清地形，100 是 224×224 = 5 万根柱子，手机上必掉帧。
         */
        density: Math.round(clamp(parsed.density, 20, 100, defaults.density)),
        amplitude: Math.round(clamp(parsed.amplitude, 0, 100, defaults.amplitude)),
        range: Math.round(clamp(parsed.range, 0, 100, defaults.range)),
        lower: Math.round(clamp(parsed.lower, 0, 100, defaults.lower)),
        depth: Math.round(clamp(parsed.depth, 0, 100, defaults.depth)),
        glow: Math.round(clamp(parsed.glow, 0, 100, defaults.glow)),
        smoothness: Math.round(clamp(parsed.smoothness, 0, 100, defaults.smoothness)),
        sharpness: Math.round(clamp(parsed.sharpness, 0, 100, defaults.sharpness)),
    };
};

export default defineBackgroundTuning<SonicBackgroundTuning>({
    mode: 'sonic',
    defaults: DEFAULT_SONIC_BACKGROUND_TUNING,
    settingsKey: 'sonicBackgroundTuning',
    settingsSetterKey: 'handleSetSonicBackgroundTuning',
    settingsResetterKey: 'handleResetSonicBackgroundTuning',
    storage: {
        key: 'sonic_background_tuning',
        read: resolveStoredSonicBackgroundTuning,
        merge: (held, patch) => resolveStoredSonicBackgroundTuning({ ...held, ...patch }),
    },
});
