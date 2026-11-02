import { defineVisualizerTuning } from '../tuningDefinition';
import { DEFAULT_KINETIC_TUNING, resolveKineticTuning, type KineticTuning } from './types';

// src/components/visualizer/kinetic/tuning.ts
// 文字PV 的 tuning 声明：默认值、它在设置仓库里的三个字段名、存储键与读写收敛。
// 存储键发布后不改名；read 把任何存储形状收敛成一套完整、在范围内的参数。

declare module '../tuningDefinition' {
    interface VisualizerTuningSettings {
        kineticTuning: KineticTuning;
        handleSetKineticTuning: (patch: Partial<KineticTuning>) => void;
        handleResetKineticTuning: () => void;
    }
}

export default defineVisualizerTuning<KineticTuning>({
    mode: 'kinetic',
    defaults: DEFAULT_KINETIC_TUNING,
    settingsKey: 'kineticTuning',
    settingsSetterKey: 'handleSetKineticTuning',
    settingsResetterKey: 'handleResetKineticTuning',
    storage: {
        key: 'kinetic_tuning',
        read: (stored: Partial<KineticTuning>) => resolveKineticTuning(stored),
        merge: (held: KineticTuning, patch: Partial<KineticTuning>) => resolveKineticTuning({ ...held, ...patch }),
        resetNotice: 'notifications.kineticReset',
    },
});
