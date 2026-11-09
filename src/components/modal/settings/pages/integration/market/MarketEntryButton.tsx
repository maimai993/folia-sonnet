// src/components/modal/settings/pages/integration/market/MarketEntryButton.tsx
//
// 「打开市场」那颗小按钮。
//
// 三处自定义设置旁边都要有（自定义图片背景、自定义视频背景、自定义字体），
// 而市场本身是一个独立面板。为了让这三处不各写一套打开逻辑，
// 这里用一个极轻量的全局事件把「打开市场」广播给面板的宿主（SettingsModal）。
//
// 为什么不用 context：这三处在设置弹窗内部的层级很深、且有一部分在可视化卡片里，
// 逐层透传 props 会污染一大片签名；一个 CustomEvent 就够，也不需要跨进程。

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Store } from 'lucide-react';
import { Button } from '../../../../settings/kit';

/** 打开市场面板的事件名。宿主监听它，打开 MarketPanel。 */
export const OPEN_MARKET_EVENT = 'folia:open-market';

/**
 * 从任意位置请求打开市场面板。
 *
 * 单独导出是因为有些调用点不是「一颗按钮」的形式（比如字体选择器里
 * 要顺手先关掉自己的弹窗再开市场）。
 */
export const openMarketPanel = (tab: 'background' | 'font' = 'background'): void => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(OPEN_MARKET_EVENT, { detail: { tab } }));
};

interface MarketEntryButtonProps {
    /** 打开后默认停在哪个 tab。 */
    tab?: 'background' | 'font';
}

const MarketEntryButton: React.FC<MarketEntryButtonProps> = ({ tab = 'background' }) => {
    const { t } = useTranslation();
    return (
        <Button
            icon={Store}
            onClick={() => openMarketPanel(tab)}
        >
            {t('options.marketOpen')}
        </Button>
    );
};

export default MarketEntryButton;
