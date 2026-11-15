// src/components/modal/settings/useMarketPanel.ts
//
// 市场面板的开合状态，从 SettingsModal 里抽出来。
//
// 为什么单独放这儿：市场是从设置内**任意位置**叫出来的（播放页的视频层、
// 外观页的莫奈背景、字体设置…），靠 OPEN_MARKET_EVENT 广播请求。
// 监听器必须挂在设置弹窗这一层 —— 设置页是按需挂载的，监听器若只写在
// 「连接与集成」页里，从别的页面点按钮就没人接，表现是「点了没反应」。
//
// 抽出成 hook 也让 SettingsModal 不必为此涨行数（它有 800 行上限的基线）。

import { useEffect, useState } from 'react';
import { OPEN_MARKET_EVENT } from './pages/integration/market/MarketEntryButton';

export type MarketTabId = 'background' | 'font';

export interface MarketPanelState {
    isOpen: boolean;
    initialTab: MarketTabId;
    close: () => void;
}

export const useMarketPanel = (): MarketPanelState => {
    const [isOpen, setOpen] = useState(false);
    const [initialTab, setInitialTab] = useState<MarketTabId>('background');

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ tab?: MarketTabId }>).detail;
            setInitialTab(detail?.tab ?? 'background');
            setOpen(true);
        };
        window.addEventListener(OPEN_MARKET_EVENT, handler);
        return () => window.removeEventListener(OPEN_MARKET_EVENT, handler);
    }, []);

    return { isOpen, initialTab, close: () => setOpen(false) };
};
