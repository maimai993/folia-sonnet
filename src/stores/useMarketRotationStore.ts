// src/stores/useMarketRotationStore.ts
//
// 背景随机轮换的设置。
//
// 轮换的意思是：隔一段时间自己换一张背景，而不是一直停在选好的那一张。
//
// 三个维度要记清楚：
//   · 用到哪 —— 可视化页面 / 桌面壁纸（可多选）
//   · 用什么 —— 只要视频 / 只要图片 / 两者都要
//   · 多久换 —— 切换间隔（秒）
//
// 「两者都要」不是先把视频放完再放图片，而是轮到哪个就把模式切成哪个；
// 所以应用目标那边的模式切换逻辑必须跟着类型走，见 services/backgroundMarket/rotation.ts。

import { create } from 'zustand';

export type RotationTarget = 'visualizer' | 'wallpaper';
export type RotationMediaKind = 'video' | 'image' | 'both';

export interface MarketRotationSettings {
    enabled: boolean;
    /** 轮换结果应用到哪些地方。 */
    targets: RotationTarget[];
    /** 允许出现哪类背景。 */
    mediaKind: RotationMediaKind;
    /** 间隔秒数。 */
    intervalSeconds: number;
}

const STORAGE_KEY = 'foliaMarketRotation';

export const DEFAULT_ROTATION: MarketRotationSettings = {
    enabled: false,
    targets: ['visualizer'],
    mediaKind: 'both',
    // 10 分钟是个折中：太短会把下载压死（视频要几十 MB），太长就感觉不到在轮换。
    intervalSeconds: 600,
};

const readStored = (): MarketRotationSettings => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_ROTATION;
        const parsed = JSON.parse(raw) as Partial<MarketRotationSettings>;
        return {
            enabled: Boolean(parsed.enabled),
            targets: Array.isArray(parsed.targets) && parsed.targets.length > 0
                ? parsed.targets.filter((entry): entry is RotationTarget => entry === 'visualizer' || entry === 'wallpaper')
                : DEFAULT_ROTATION.targets,
            mediaKind: parsed.mediaKind === 'video' || parsed.mediaKind === 'image' || parsed.mediaKind === 'both'
                ? parsed.mediaKind
                : DEFAULT_ROTATION.mediaKind,
            intervalSeconds: typeof parsed.intervalSeconds === 'number' && parsed.intervalSeconds >= 60
                ? parsed.intervalSeconds
                : DEFAULT_ROTATION.intervalSeconds,
        };
    } catch {
        return DEFAULT_ROTATION;
    }
};

const persist = (settings: MarketRotationSettings): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // 存不下不影响本次会话。
    }
};

interface RotationState extends MarketRotationSettings {
    setEnabled: (enabled: boolean) => void;
    toggleTarget: (target: RotationTarget) => void;
    setMediaKind: (kind: RotationMediaKind) => void;
    setIntervalSeconds: (seconds: number) => void;
    /** 当前轮换到第几个（用于同一个源内顺序推进，避免连着抽中同一张）。 */
    cursor: number;
    advanceCursor: () => void;
}

export const useMarketRotationStore = create<RotationState>((set, get) => {
    const initial = readStored();
    const update = (patch: Partial<MarketRotationSettings>) => {
        const next = { ...get(), ...patch };
        const settings: MarketRotationSettings = {
            enabled: next.enabled,
            targets: next.targets,
            mediaKind: next.mediaKind,
            intervalSeconds: next.intervalSeconds,
        };
        persist(settings);
        set(settings);
    };

    return {
        ...initial,
        cursor: 0,
        setEnabled: (enabled) => update({ enabled }),
        toggleTarget: (target) => {
            const current = get().targets;
            const next = current.includes(target)
                ? current.filter((entry) => entry !== target)
                : [...current, target];
            // 一个去处都不留等于没开，那就别允许清空。
            update({ targets: next.length > 0 ? next : current });
        },
        setMediaKind: (mediaKind) => update({ mediaKind }),
        setIntervalSeconds: (intervalSeconds) => update({ intervalSeconds }),
        advanceCursor: () => set((state) => ({ cursor: state.cursor + 1 })),
    };
});

/** 这个设置下要不要视频 / 要不要图片。 */
export const rotationAllows = (mediaKind: RotationMediaKind, kind: 'video' | 'image'): boolean => (
    mediaKind === 'both' || mediaKind === kind
);
