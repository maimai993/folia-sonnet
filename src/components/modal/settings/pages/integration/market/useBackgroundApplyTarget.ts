// src/components/modal/settings/pages/integration/market/useBackgroundApplyTarget.ts
//
// 背景「用在哪」的选择与持久化。
//
// 三个去处：
//   · wallpaper  桌面/锁屏的系统壁纸（原生渲染层）
//   · app        App 内的歌词可视化背景（网页层）
//   · monet      歌词样式里莫奈背景的自定义图片来源（只有静图能去，见 apply.ts）
//
// 和字体那边一样，应用范围要能事后改，所以整体存在一处。

import { useCallback, useEffect, useState } from 'react';
import type { BackgroundMarketKind } from '../../../../../../services/backgroundMarket';

export type BackgroundTarget = 'wallpaper' | 'app' | 'monet';

export interface AppliedMarketBackground {
    kind: BackgroundMarketKind;
    name: string;
    appliesTo: BackgroundTarget[];
}

const STORAGE_KEY = 'foliaAppliedMarketBackground';

const readStored = (): AppliedMarketBackground | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AppliedMarketBackground>;
        if (!parsed.kind) return null;
        return {
            kind: parsed.kind,
            name: parsed.name ?? '',
            appliesTo: Array.isArray(parsed.appliesTo) ? parsed.appliesTo : ['app'],
        };
    } catch {
        return null;
    }
};

export const useBackgroundApplyTarget = () => {
    const [target, setTargetState] = useState<AppliedMarketBackground | null>(null);

    useEffect(() => {
        setTargetState(readStored());
    }, []);

    const persist = useCallback((next: AppliedMarketBackground | null) => {
        setTargetState(next);
        try {
            if (next) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } else {
                localStorage.removeItem(STORAGE_KEY);
            }
        } catch {
            // 存不下不影响本次会话。
        }
    }, []);

    const setTarget = useCallback((next: AppliedMarketBackground | null) => persist(next), [persist]);

    /** 只改应用范围，不重新下载。 */
    const updateAppliesTo = useCallback((appliesTo: BackgroundTarget[]) => {
        setTargetState((previous) => {
            if (!previous) return previous;
            const next = { ...previous, appliesTo };
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
                // 同上。
            }
            return next;
        });
    }, []);

    return { target, setTarget, updateAppliesTo };
};
