// src/components/visualizer/kinetic/types.ts
// 文字PV（kinetic）的 tuning 类型与默认值：只给这个样式用，放在它自己的目录里。

export type KineticEntranceStyle = 'pop' | 'slide' | 'drop' | 'wipe';
export type KineticLayoutMode = 'cascade' | 'grid' | 'block';

export interface KineticTuning {
    /** 逐字入场动画风格：弹入 / 滑入 / 下坠 / 擦除。 */
    entrance: KineticEntranceStyle;
    /** 排版布局：居中阶梯 / 错落网格 / 整块强调。 */
    layout: KineticLayoutMode;
    /** 逐字入场延迟的倍率（1 = 按歌词时序原样，越大字与字拉开越开）。 */
    staggerScale: number;
    /** 当前字强调时的缩放幅度（1 = 不放大）。 */
    activeScale: number;
    /** 行级位移幅度（px，阶梯错落与网格抖动的基准量）。 */
    offsetAmplitude: number;
    /** 装饰下划线块开关。 */
    showUnderline: boolean;
    /** 强调字残影开关。 */
    showEcho: boolean;
    /** 镜头晃动强度（0 = 关，1 = 默认轻微晃动）。 */
    cameraShake: number;
    /** 字描边开关（描边用主题次色，正文用主色）。 */
    showStroke: boolean;
}

export const DEFAULT_KINETIC_TUNING: KineticTuning = {
    entrance: 'pop',
    layout: 'cascade',
    staggerScale: 1,
    activeScale: 1.18,
    offsetAmplitude: 14,
    showUnderline: true,
    showEcho: false,
    cameraShake: 0.4,
    showStroke: false,
};

/** tuning 的收敛：任何存储形状都回到一套完整、在范围内的参数（照 tilt/pendolo 的写法）。 */
export const resolveKineticTuning = (tuning?: Partial<KineticTuning>): KineticTuning => {
    const entrances: KineticEntranceStyle[] = ['pop', 'slide', 'drop', 'wipe'];
    const layouts: KineticLayoutMode[] = ['cascade', 'grid', 'block'];
    const entrance = entrances.includes(tuning?.entrance as KineticEntranceStyle)
        ? tuning!.entrance as KineticEntranceStyle
        : DEFAULT_KINETIC_TUNING.entrance;
    const layout = layouts.includes(tuning?.layout as KineticLayoutMode)
        ? tuning!.layout as KineticLayoutMode
        : DEFAULT_KINETIC_TUNING.layout;
    const clamp = (value: number | undefined, fallback: number, min: number, max: number) => (
        typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
    );

    return {
        entrance,
        layout,
        staggerScale: clamp(tuning?.staggerScale, DEFAULT_KINETIC_TUNING.staggerScale, 0, 2),
        activeScale: clamp(tuning?.activeScale, DEFAULT_KINETIC_TUNING.activeScale, 1, 1.6),
        offsetAmplitude: clamp(tuning?.offsetAmplitude, DEFAULT_KINETIC_TUNING.offsetAmplitude, 0, 48),
        showUnderline: typeof tuning?.showUnderline === 'boolean' ? tuning.showUnderline : DEFAULT_KINETIC_TUNING.showUnderline,
        showEcho: typeof tuning?.showEcho === 'boolean' ? tuning.showEcho : DEFAULT_KINETIC_TUNING.showEcho,
        cameraShake: clamp(tuning?.cameraShake, DEFAULT_KINETIC_TUNING.cameraShake, 0, 2),
        showStroke: typeof tuning?.showStroke === 'boolean' ? tuning.showStroke : DEFAULT_KINETIC_TUNING.showStroke,
    };
};
