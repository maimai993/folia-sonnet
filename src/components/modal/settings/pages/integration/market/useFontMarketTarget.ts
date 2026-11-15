// src/components/modal/settings/pages/integration/market/useFontMarketTarget.ts
//
// 字体「用在哪」的选择与持久化。
//
// 三种去处：
//   · lyric     歌词（可视化里的主歌词）
//   · subtitle  字幕
//   · wallpaper 桌面/锁屏的系统壁纸歌词（安卓，要完整的字体文件）
//
// 应用范围要能**事后改**，所以选中的字体整体存在这里，
// 换位置只改 `appliesTo`，不重新下载。

import { useCallback, useEffect, useState } from 'react';

export type FontMarketTarget = 'lyric' | 'subtitle' | 'wallpaper';

export interface AppliedMarketFont {
    /** 字体家族名，直接用在 CSS 的 font-family。 */
    family: string;
    /** 字体天下的数字 ID，用来做 key 与重新下载。 */
    fontId: string;
    /** 显示用的名字。 */
    name: string;
    /** 当前应用到哪里。 */
    appliesTo: FontMarketTarget[];
}

const STORAGE_KEY = 'foliaAppliedMarketFont';

const readStored = (): AppliedMarketFont | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AppliedMarketFont>;
        if (!parsed.family || !parsed.fontId) return null;
        return {
            family: parsed.family,
            fontId: parsed.fontId,
            name: parsed.name ?? parsed.fontId,
            appliesTo: Array.isArray(parsed.appliesTo) ? parsed.appliesTo : ['lyric'],
        };
    } catch {
        return null;
    }
};

export const useFontMarketTarget = () => {
    const [target, setTargetState] = useState<AppliedMarketFont | null>(null);

    // 冷启动时恢复上次的选择（字体本身由 useAppPreferences 重新注册）。
    useEffect(() => {
        setTargetState(readStored());
    }, []);

    const persist = useCallback((next: AppliedMarketFont | null) => {
        setTargetState(next);
        try {
            if (next) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } else {
                localStorage.removeItem(STORAGE_KEY);
            }
        } catch {
            // 存不下不影响本次会话，下次冷启动回到默认字体。
        }
    }, []);

    /** 装好一个新字体。默认应用到歌词。 */
    const setTarget = useCallback((next: Omit<AppliedMarketFont, 'appliesTo'> & { appliesTo?: FontMarketTarget[] }) => {
        persist({
            family: next.family,
            fontId: next.fontId,
            name: next.name,
            appliesTo: next.appliesTo ?? ['lyric'],
        });
    }, [persist]);

    /** 只改应用范围，不碰字体本身 —— 这是「后续改应用范围」的入口。 */
    const updateAppliesTo = useCallback((appliesTo: FontMarketTarget[]) => {
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

    const clearTarget = useCallback(() => persist(null), [persist]);

    return { target, setTarget, updateAppliesTo, clearTarget };
};
