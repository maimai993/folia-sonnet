import type { ParticlesBackgroundTuning } from '../../../../types';
import { DEFAULT_PARTICLES_BACKGROUND_TUNING } from '../../../../types';
import { defineBackgroundTuning, type StoredTuningFields } from '../../tuningDefinition';
import { isParticlesForm } from './forms';

// src/components/visualizer/backgrounds/particles/tuning.ts
// 粒子背景的可调项。
//
// 这个背景是从 Mineradio 的封面粒子搬过来的，但搬的时候只带走了画面，没带走调参 ——
// 那边有一整组 uniform（uIntensity / uDepth / uPointScale / uSpeed / uScatter /
// uBloomStrength / uTwist / uBgFade …），用户能自己调疏密、大小、速度、散开程度。
// 这里只挑**我们着色器真的实现了**的那几个：暴露一个不生效的滑条比没有更糟。
//
// 和 Mineradio 的差别要说清楚：
//   · 那边是 three.js + 后处理 bloom，我们是单 pass + 合成镜像画布，没有 bloom 这一层；
//   · 因此 bloom 相关的项（uBloomStrength / uBloomSize）在这里没有对应物，不暴露；
//   · uScatter / uTwist 在我们的顶点着色器里也没实现，同样不暴露。
//
// 现在这一组是真正接进着色器的：网格密度、整体强度、粒子大小、自动涟漪、着色强度。

declare module '../definition' {
    interface VisualizerBackgroundConfig {
        particles?: BackgroundTuningSlot<ParticlesBackgroundTuning>;
    }
    interface VisualizerBackgroundActions {
        particles?: BackgroundTuningActionSlot<ParticlesBackgroundTuning>;
    }
}

declare module '../../tuningDefinition' {
    interface VisualizerTuningSettings extends StoredTuningFields<'particlesBackgroundTuning', 'handleSetParticlesBackgroundTuning', 'handleResetParticlesBackgroundTuning', ParticlesBackgroundTuning> {}
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback
);

const resolveStoredParticlesBackgroundTuning = (
    parsed: Partial<ParticlesBackgroundTuning>,
): ParticlesBackgroundTuning => {
    const defaults = DEFAULT_PARTICLES_BACKGROUND_TUNING;
    return {
        /*
         * 形态。存坏了（改过名、手改配置）就退回默认，不要抛 ——
         * 一个读不出来的调参项不该让整个背景画不出来。
         * 旧存档里的 'void'（已删掉的形态）也走这条路，落回「自动」。
         */
        form: isParticlesForm(parsed.form) ? parsed.form : defaults.form,
        // 每边格数。64 太糊、128 在手机上掉帧，默认 96 是这套着色器调好的密度。
        grid: Math.round(clamp(parsed.grid, 32, 192, defaults.grid)),
        intensity: clamp(parsed.intensity, 0, 2, defaults.intensity),
        pointScale: clamp(parsed.pointScale, 0.4, 2.5, defaults.pointScale),
        tintStrength: clamp(parsed.tintStrength, 0, 1, defaults.tintStrength),
        autoRipple: typeof parsed.autoRipple === 'boolean' ? parsed.autoRipple : defaults.autoRipple,
    };
};

export default defineBackgroundTuning<ParticlesBackgroundTuning>({
    mode: 'particles',
    defaults: DEFAULT_PARTICLES_BACKGROUND_TUNING,
    settingsKey: 'particlesBackgroundTuning',
    settingsSetterKey: 'handleSetParticlesBackgroundTuning',
    settingsResetterKey: 'handleResetParticlesBackgroundTuning',
    storage: {
        key: 'particles_background_tuning',
        read: resolveStoredParticlesBackgroundTuning,
        merge: (held, patch) => resolveStoredParticlesBackgroundTuning({ ...held, ...patch }),
    },
});
