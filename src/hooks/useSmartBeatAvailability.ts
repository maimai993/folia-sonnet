import { useEffect, useState } from 'react';
import { probeBeatThisGpu } from '../services/analysis/beatThisGpu';
import { isNativeBeatAnalysisAvailable } from '../services/automix/nativeBeats';
import type { SmartBeatMode } from '../types';

// src/hooks/useSmartBeatAvailability.ts
// Whether beat FX (智能动感模式, in every mode and background that draws them) can do anything on this
// install, for a setting to say so next to its switch. The switch itself stays usable either way - it
// is a preference - but a switch that is on and silently inert is the failure this is here to prevent.
//
// 三条路，按平台选：
//   · 安卓 App —— beat_this 权重内置在 APK 里，推理走 onnxruntime-android（nativeBeats.ts）。
//     这里问的是「原生模型能不能跑」，不是「有没有 GPU」；
//   · 桌面 —— 权重随应用发货，由主进程的桥交出来（window.electron），GPU 出 adapter 才能跑；
//   · 网页版 —— 既没有原生层也没有主进程桥，只能是 desktopOnly。
//
// 原来这里只有第二条：`hasBeatThisBridge()` 问 window.electron，
// 安卓上它必然是 undefined，于是整个节拍效果被判定成「仅桌面版可用」——
// 而权重其实已经在包里了，只是没人去问原生那一份。
// 这就是「去掉节拍效果仅在桌面版可用」要修的地方。

export type SmartBeatAvailability = 'ready' | 'desktopOnly' | 'noGpu';

const hasBeatThisBridge = () => typeof window !== 'undefined' && typeof window.electron?.getBeatThisGpuWeights === 'function';

/**
 * The GPU is probed only under `on`, and only where the GPU path is the one that runs. Off, nothing
 * is probed (no adapter request) and the answer is 'ready', which a caller shows nothing for.
 */
export function useSmartBeatAvailability(mode: SmartBeatMode): SmartBeatAvailability {
    // Optimistic until the probe answers: a hint flashing "no GPU" on every open would be worse.
    const [gpu, setGpu] = useState(true);
    const native = isNativeBeatAnalysisAvailable();

    const probe = mode === 'on' && !native;

    useEffect(() => {
        if (!probe) return;
        let cancelled = false;
        void probeBeatThisGpu().then((found) => {
            if (!cancelled) setGpu(found);
        });
        return () => {
            cancelled = true;
        };
    }, [probe]);

    if (mode === 'off') return 'ready';

    /*
     * 安卓这条路：有原生推理能力就一定 ready。
     *
     * 为什么不看「模型是否已落盘」：权重是内置的，所谓准备只是把 assets 拷到私有目录，
     * 这一步总是会成功。如果要求「已落盘」才算 ready，用户第一次点开设置就会看到
     * 「不可用」—— 而实际上只要他按下播放，它自己就会准备好。
     */
    if (native) return 'ready';

    if (!hasBeatThisBridge()) return 'desktopOnly';
    return gpu || !probe ? 'ready' : 'noGpu';
}
