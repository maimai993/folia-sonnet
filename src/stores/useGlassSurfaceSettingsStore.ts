import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';
import {
    LIQUID_GLASS_EFFECT_KEYS,
    LIQUID_GLASS_STORAGE_KEYS,
    applyLiquidGlassParams,
    clampLiquidGlassParam,
    readStoredLiquidGlassEffects,
    readStoredLiquidGlassParams,
    setLiquidGlassJellyEnabled,
    setLiquidGlassLightEnabled,
    type LiquidGlassEffects,
    type LiquidGlassParams,
} from '../shinoinject/liquidglass';
import { installGlassSurfaces, removeGlassSurfaces } from '../shinoinject/injectGlassSurfaces';

// src/stores/useGlassSurfaceSettingsStore.ts
// 液态玻璃（流体玻璃）：总开关、四个数值参数（折射强度 strength、模糊 blur、饱和度 sat、
// 最大弯曲距离 bend，见 src/shinoinject/liquidglass.ts）与两个效果开关（光效 light、果冻 jelly）。
//
// 打开之后界面上的玻璃面板（搜索框、侧栏、命令面板、弹层）换成带边缘折射的玻璃。它是纯装饰，
// 也真的贵 —— 位移图要逐像素画，所以默认关，参数与效果开关的默认值与读回都定义在 liquidglass.ts
// （它的 global 是运行时实际生效的那份），这里只负责持久化、钳制后的 state 和 setter；
// setter 同步调 liquidglass 的入口，让在场的玻璃 / 效果立刻重画或收摊。
//
// 「节能」是预设（strength/blur/bend 都为 0，只剩饱和，接近不耗位移图），不单独占一个开关。

const LIQUID_GLASS_ENABLED_KEY = 'folia_liquid_glass_enabled';

const persistParam = (key: string, value: number) => {
    if (typeof window !== 'undefined') localStorage.setItem(key, String(value));
};

const persistFlag = (key: string, value: boolean) => {
    if (typeof window !== 'undefined') localStorage.setItem(key, value ? '1' : '0');
};

export type GlassSurfaceSettingsState = LiquidGlassParams & LiquidGlassEffects & {
    /** 总开关：打开时给全站玻璃面板挂折射滤镜。 */
    liquidGlassEnabled: boolean;
    setLiquidGlassEnabled: (enabled: boolean) => void;
    handleSetLiquidGlassStrength: (value: number) => void;
    handleSetLiquidGlassBlur: (value: number) => void;
    handleSetLiquidGlassSat: (value: number) => void;
    handleSetLiquidGlassBend: (value: number) => void;
    handleSetLiquidGlassLight: (enabled: boolean) => void;
    handleSetLiquidGlassJelly: (enabled: boolean) => void;
    /** 整组写入：套用预设或导入外观配置时一次应用，落库与刷新各走一次（未给的字段保持现值）。 */
    handleSetLiquidGlassParams: (patch: Partial<LiquidGlassParams & LiquidGlassEffects>) => void;
};

/**
 * 写到 `<html data-liquid-glass='on'>`，注入器据此给全站的玻璃面板挂滤镜。
 *
 * 没有逐个组件去加 data-glass：面板散落在各处，还有不少是第三方组件自带的，枚举一遍必然漏；
 * 注入器按 injectGlassSurfaces.ts 的那组玻璃选择器找面板，开关联动只挂这一个属性。
 */
const syncGlassAttribute = (enabled: boolean): void => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    if (enabled) {
        document.documentElement.setAttribute('data-liquid-glass', 'on');
        installGlassSurfaces();
    } else {
        document.documentElement.removeAttribute('data-liquid-glass');
        removeGlassSurfaces();
    }
};

export const useGlassSurfaceSettingsStore = create<GlassSurfaceSettingsState>((set, get) => {
    // 一次写入：钳制 → 落 localStorage → 更新 state → 重刷已挂玻璃 / 应用效果开关。
    const commit = (patch: Partial<LiquidGlassParams & LiquidGlassEffects>) => {
        const next: LiquidGlassParams = {
            strength: patch.strength !== undefined ? clampLiquidGlassParam('strength', patch.strength) : get().strength,
            blur: patch.blur !== undefined ? clampLiquidGlassParam('blur', patch.blur) : get().blur,
            sat: patch.sat !== undefined ? clampLiquidGlassParam('sat', patch.sat) : get().sat,
            bend: patch.bend !== undefined ? clampLiquidGlassParam('bend', patch.bend) : get().bend,
        };
        const light = patch.light !== undefined ? patch.light : get().light;
        const jelly = patch.jelly !== undefined ? patch.jelly : get().jelly;
        set({ ...next, light, jelly });
        persistParam(LIQUID_GLASS_STORAGE_KEYS.strength, next.strength);
        persistParam(LIQUID_GLASS_STORAGE_KEYS.blur, next.blur);
        persistParam(LIQUID_GLASS_STORAGE_KEYS.sat, next.sat);
        persistParam(LIQUID_GLASS_STORAGE_KEYS.bend, next.bend);
        persistFlag(LIQUID_GLASS_EFFECT_KEYS.light, light);
        persistFlag(LIQUID_GLASS_EFFECT_KEYS.jelly, jelly);
        applyLiquidGlassParams(next);
        setLiquidGlassLightEnabled(light);
        setLiquidGlassJellyEnabled(jelly);
    };

    return {
        // 默认关：液态玻璃是观感增强，不是界面原本的样子。
        liquidGlassEnabled: getStoredBoolean(LIQUID_GLASS_ENABLED_KEY, false),
        ...readStoredLiquidGlassParams(),
        ...readStoredLiquidGlassEffects(),
        setLiquidGlassEnabled: (enabled) => {
            setStoredBoolean(LIQUID_GLASS_ENABLED_KEY, enabled);
            set({ liquidGlassEnabled: enabled });
            syncGlassAttribute(enabled);
        },
        handleSetLiquidGlassStrength: (value) => commit({ strength: value }),
        handleSetLiquidGlassBlur: (value) => commit({ blur: value }),
        handleSetLiquidGlassSat: (value) => commit({ sat: value }),
        handleSetLiquidGlassBend: (value) => commit({ bend: value }),
        handleSetLiquidGlassLight: (enabled) => commit({ light: enabled }),
        handleSetLiquidGlassJelly: (enabled) => commit({ jelly: enabled }),
        handleSetLiquidGlassParams: (patch) => commit(patch),
    };
});

// 第一帧之前就挂上开关状态：开着的机器一启动玻璃就是好的，不用等设置弹窗被打开。
syncGlassAttribute(useGlassSurfaceSettingsStore.getState().liquidGlassEnabled);
