import type { HanabiTuning } from '../../components/visualizer/hanabi/types';
import type { MachiTuning } from '../../components/visualizer/machi/types';
import type {
    CadenzaTuning,
    CappellaTuning,
    CladdaghTuning,
    ClassicTuning,
    DioramaTuning,
    FumeTuning,
    LumiereTuning,
    MonetTuning,
    PartitaTuning,
    PendoloTuning,
    SonnetTuning,
    TemperaTuning,
    TiltTuning,
} from '../../types';

// src/utils/visualizer/tunings.ts
// 各模式 tuning 在设置里住在哪个字段、以及按它读 / 写设置的两个人。
//
// **为什么在低层**：同步快照（services/sync/settingsSnapshot）与 OBS 配置
// （services/obs/visualSettingsConfig）只按字段名取值、调 setter，它们都不在 components 下，
// 不能 import components/visualizer/tuningRegistry —— 那份 registry 用 import.meta.glob
// eager 拉进全部 tuning 适配器，是渲染期才需要的东西（而挂上它就等于挂上组件目录）。
//
// 键名同时写在各模式的 tuning.ts 里（registry 用它们做渲染期注入）。两处不能各说各话：
// registry 初始化时逐条比对（assertVisualizerTuningKeys），对不上当场炸 —— 否则
// collectVisualizerTunings 与 applyVisualizerTuningsToSettings 会指向不同的字段，
// 同步过去的值落不到该落的地方，而从现象几乎反推不出来。

export interface VisualizerTuningMap {
    classic: ClassicTuning;
    cadenza: CadenzaTuning;
    partita: PartitaTuning;
    fume: FumeTuning;
    claddagh: CladdaghTuning;
    cappella: CappellaTuning;
    tilt: TiltTuning;
    diorama: DioramaTuning;
    monet: MonetTuning;
    pendolo: PendoloTuning;
    sonnet: SonnetTuning;
    tempera: TemperaTuning;
    lumiere: LumiereTuning;
    hanabi: HanabiTuning;
    machi: MachiTuning;
}

export type VisualizerTuningMode = keyof VisualizerTuningMap;
export type VisualizerTuningBundle = Partial<VisualizerTuningMap>;

/**
 * mode -> 设置字段名 + 写它的 setter 名。
 *
 * 上面的 Map 是权威（哪些模式有 tuning），这张表逐条补上它们住在哪；`satisfies` 保证
 * 两边不多不少 —— 加了新模式却忘了补键，这里编译期就报。
 */
export const VISUALIZER_TUNING_KEYS = {
    classic: { settingsKey: 'classicTuning', settingsSetterKey: 'handleSetClassicTuning' },
    cadenza: { settingsKey: 'cadenzaTuning', settingsSetterKey: 'handleSetCadenzaTuning' },
    partita: { settingsKey: 'partitaTuning', settingsSetterKey: 'handleSetPartitaTuning' },
    fume: { settingsKey: 'fumeTuning', settingsSetterKey: 'handleSetFumeTuning' },
    claddagh: { settingsKey: 'claddaghTuning', settingsSetterKey: 'handleSetCladdaghTuning' },
    cappella: { settingsKey: 'cappellaTuning', settingsSetterKey: 'handleSetCappellaTuning' },
    tilt: { settingsKey: 'tiltTuning', settingsSetterKey: 'handleSetTiltTuning' },
    diorama: { settingsKey: 'dioramaTuning', settingsSetterKey: 'handleSetDioramaTuning' },
    monet: { settingsKey: 'monetTuning', settingsSetterKey: 'handleSetMonetTuning' },
    pendolo: { settingsKey: 'pendoloTuning', settingsSetterKey: 'handleSetPendoloTuning' },
    sonnet: { settingsKey: 'sonnetTuning', settingsSetterKey: 'handleSetSonnetTuning' },
    tempera: { settingsKey: 'temperaTuning', settingsSetterKey: 'handleSetTemperaTuning' },
    lumiere: { settingsKey: 'lumiereTuning', settingsSetterKey: 'handleSetLumiereTuning' },
    hanabi: { settingsKey: 'hanabiTuning', settingsSetterKey: 'handleSetHanabiTuning' },
    machi: { settingsKey: 'machiTuning', settingsSetterKey: 'handleSetMachiTuning' },
} as const satisfies Record<VisualizerTuningMode, { settingsKey: string; settingsSetterKey: string }>;

export const VISUALIZER_TUNING_MODES = Object.keys(VISUALIZER_TUNING_KEYS) as VisualizerTuningMode[];

/** 按表把设置里现存的 tuning 收成一个 bundle。 */
export const collectVisualizerTunings = (settings: Record<string, unknown>): VisualizerTuningBundle => {
    const bundle: VisualizerTuningBundle = {};
    VISUALIZER_TUNING_MODES.forEach((mode) => {
        const value = settings[VISUALIZER_TUNING_KEYS[mode].settingsKey];
        if (value !== undefined) {
            (bundle as Record<string, unknown>)[mode] = value;
        }
    });
    return bundle;
};

/** 按表把 bundle 写回设置 —— 只认 bundle 里真的有的那几个模式。 */
export const applyVisualizerTuningsToSettings = (
    settings: Record<string, unknown>,
    bundle: VisualizerTuningBundle,
) => {
    VISUALIZER_TUNING_MODES.forEach((mode) => {
        const value = bundle[mode];
        const setter = settings[VISUALIZER_TUNING_KEYS[mode].settingsSetterKey];
        if (value !== undefined && typeof setter === 'function') {
            setter(value);
        }
    });
};

/**
 * 表与各模式 tuning.ts 的声明比对。由 registry 在初始化时调一次（它才看得到那些声明）。
 *
 * 两边都缺一不可：只有表 → 渲染期注入拿不到 tuning；只有声明 → 同步与 OBS 配置读写不到。
 */
export const assertVisualizerTuningKeys = (
    label: string,
    adapters: readonly { mode: string; settingsKey: string; settingsSetterKey: string }[],
): void => {
    const drift = adapters.flatMap((adapter) => {
        const expected = VISUALIZER_TUNING_KEYS[adapter.mode as VisualizerTuningMode] as
            | { settingsKey: string; settingsSetterKey: string }
            | undefined;
        if (!expected) return [`${adapter.mode} 只在 tuning.ts 里，表里没有`];
        const fields = [
            adapter.settingsKey === expected.settingsKey ? null : `settingsKey 是 ${adapter.settingsKey}，表里是 ${expected.settingsKey}`,
            adapter.settingsSetterKey === expected.settingsSetterKey ? null : `settingsSetterKey 是 ${adapter.settingsSetterKey}，表里是 ${expected.settingsSetterKey}`,
        ].filter((field): field is string => field !== null);
        return fields.length > 0 ? [`${adapter.mode} 的 ${fields.join('；')}`] : [];
    });
    const declared = new Set(adapters.map(adapter => adapter.mode));
    const missing = VISUALIZER_TUNING_MODES
        .filter(mode => !declared.has(mode))
        .map(mode => `${mode} 在表里，却没有 tuning.ts`);
    const problems = [...drift, ...missing];
    if (problems.length === 0) return;
    throw new Error(
        `[${label}] utils/visualizer/tunings.ts 的键表与各模式 tuning.ts 不一致：`
        + `${problems.join('；')}。改完请同步两处。`,
    );
};
