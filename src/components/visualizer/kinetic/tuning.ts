import { defineVisualizerTuning } from '../tuningDefinition';

// src/components/visualizer/kinetic/tuning.ts
// 文字PV 的 tuning 声明：所有参数都在原版编辑台里调，folia 侧只留一个空 tuning 占位
// （存储键发布后不改名，保持 kinetic_tuning 不动；不再承载任何仿制参数）。

/** 文字PV 不再有 folia 侧参数；类型留空对象，存储兼容旧值（读取时忽略）。 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KineticTuning {}

declare module '../tuningDefinition' {
    interface VisualizerTuningSettings {
        kineticTuning: KineticTuning;
        handleSetKineticTuning: (patch: Partial<KineticTuning>) => void;
        handleResetKineticTuning: () => void;
    }
}

export default defineVisualizerTuning<KineticTuning>({
    mode: 'kinetic',
    defaults: {},
    settingsKey: 'kineticTuning',
    settingsSetterKey: 'handleSetKineticTuning',
    settingsResetterKey: 'handleResetKineticTuning',
    storage: {
        key: 'kinetic_tuning',
        read: () => ({}),
        merge: () => ({}),
        resetNotice: 'notifications.kineticReset',
    },
});
