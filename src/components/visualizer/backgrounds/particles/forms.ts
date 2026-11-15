// src/components/visualizer/backgrounds/particles/forms.ts
//
// 粒子的五种形态。
//
// 这五个在 Mineradio 里是**同一个粒子着色器的五个分支**（uPreset 0..4），
// 不是五套独立背景：几何、涟漪、封面采样完全一样，只有排布方式不同。
// 所以这里也只保留一份定义，供着色器、设置卡片和主组件共用。
//
// 编号与那边的 uPreset 一致，对着源码看分支时不用换算。

import { hashVisualizerSeed } from '../../visualizerSeedHash';

/**
 * 粒子形态（移植自 Mineradio 的 preset 0/1/2/4）。
 *
 * ★ 不含「虚空」（原来的 preset 3）。
 *
 * 那个分支把粒子全部裁掉、什么都不画 —— 本来是留给「自定义背景」的占位，
 * 在形态选择器里却是一个「点了就全黑」的选项，用户反馈「删除」就是它。
 * 所以这里从类型、编号表和排列里一并去掉。
 *
 * ★ 含「自动」。
 *
 * 「自动」= 随机，和町景的场景「自动」一个意思：按歌的 seed 挑一个形态，
 * 同一首歌每次进来都是同一个形态，换歌才换。
 */
export type ParticlesForm = 'auto' | 'silk' | 'tunnel' | 'planet' | 'vinyl';

/** 实际会画出来的形态（「自动」解析完之后的那几种）。 */
export type ParticlesConcreteForm = Exclude<ParticlesForm, 'auto'>;

/**
 * 形态 → 着色器里的编号。
 *
 * silk   0 · 丝绸：封面平铺在 xy 平面，z 方向做律动位移（即「专辑封面」）
 * tunnel 1 · 滚筒：极坐标环组成隧道，沿轴向流动
 * planet 2 · 星球：球面排布并绕 Y 轴自转
 * vinyl  4 · 唱片：中心一块圆形封面 + 外围黑胶纹 + 白色边圈
 *
 * 编号保留 Mineradio 原样（4 就是 4，中间空着的 3 是被删掉的虚空），
 * 不用重排 —— 重排会让「对着那边源码看分支」的人多换一次算。
 */
export const FORM_INDEX: Record<ParticlesConcreteForm, number> = {
    silk: 0,
    tunnel: 1,
    planet: 2,
    vinyl: 4,
};

/** 形态选择器里的排列顺序（「自动」在最前，和町景的场景一致）。 */
export const PARTICLES_FORMS: readonly ParticlesForm[] = ['auto', 'silk', 'tunnel', 'planet', 'vinyl'];

/** 会画出来的几种形态（「自动」在它们里面挑）。 */
export const PARTICLES_CONCRETE_FORMS: readonly ParticlesConcreteForm[] = ['silk', 'tunnel', 'planet', 'vinyl'];

/**
 * 每种形态的相机距离倍数（乘在基准距离上）。
 *
 * 基准 2.2 是按「点铺满 z≈0 一整屏」算的，直接用在别的形态上不是穿模就是贴脸。
 * 要留出一点四周空间、能看出 3D，但不能退太远 —— 退远了粒子只剩一片碎点，
 * 根本看不清（用户反馈「太远了 看不清粒子了」，从 1.85/3.1/2.6/2.2 收回来）。
 *
 *   · silk   平面阵列：轻微留边（1.55），封面主体仍占画面大半
 *   · tunnel 隧道 z 跨 ±4.5、半径 2.0 —— 退到能看进洞口（2.6）
 *   · planet 球半径 2.2 —— 球占画面中间偏大（2.15）
 *   · vinyl  唱片半径约 2.56 的圆盘（1.9），唱片边缘贴近画面边
 */
export const FORM_CAMERA_SCALE: Record<ParticlesConcreteForm, number> = {
    silk: 1.55,
    tunnel: 2.6,
    planet: 2.15,
    vinyl: 1.9,
};

/** 存储值校验：读不出来就退回「自动」，不要让一个坏字段毁掉整个背景。 */
export const isParticlesForm = (value: unknown): value is ParticlesForm => (
    typeof value === 'string' && (PARTICLES_FORMS as readonly string[]).includes(value)
);

/**
 * 这一首歌画哪种形态：选了就用选的，「自动」按 seed 挑一个。
 *
 * 和町景的场景「自动」一个做法（machi/machiTuning.ts 的 resolveMachiSceneId）：
 * 同一首歌每次进来都是同一个形态，换歌才换 —— 随机的意思是「不知道会挑到哪个」，
 * 不是「每次刷新都换一个」。
 */
export const resolveParticlesForm = (form: ParticlesForm, seed: string | number): ParticlesConcreteForm => {
    if (form !== 'auto') return form;
    const hash = hashVisualizerSeed(`particles-form:${seed}`);
    return PARTICLES_CONCRETE_FORMS[hash % PARTICLES_CONCRETE_FORMS.length]!;
};
