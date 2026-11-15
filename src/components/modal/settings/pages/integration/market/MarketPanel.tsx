// src/components/modal/settings/pages/integration/market/MarketPanel.tsx
//
// 市场面板：独立弹出的窗口。
//
// 为什么不内嵌在设置页里：设置页是一行行短条目，把背景网格（两列大图）+ 字体网格
// 铺进去会把整页拉得很长，滚动起来找不到别的设置。所以设置里只留一行入口。
//
// 两个打开方式都落到这个组件：
//   · 设置里的那一行（受控：isOpen / onClose）
//   · 各处自定义设置旁边的 MarketEntryButton（广播 OPEN_MARKET_EVENT）
// 由宿主 SettingsModal 统一监听广播、把 isOpen 置真，这里只负责「停在哪个 tab」。

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ThemedDialog from '../../../../../shared/ThemedDialog';
import MarketPage, { type MarketTabId } from '../MarketPage';
import { OPEN_MARKET_EVENT } from './MarketEntryButton';

interface MarketPanelProps {
    isOpen: boolean;
    onClose: () => void;
    /** 打开时默认停在哪个 tab（从字体入口进来就直接看字体）。 */
    initialTab?: MarketTabId;
}

const MarketPanel: React.FC<MarketPanelProps> = ({ isOpen, onClose, initialTab }) => {
    const { t } = useTranslation();
    const [tab, setTab] = useState<MarketTabId | undefined>(initialTab);

    /*
     * 广播里带的 tab 决定打开后停在哪一页。
     *
     * 用户从「自定义字体」旁边点进来，本来就该看到字体市场，
     * 而不是先看到背景再自己切 —— 那多一步没必要。
     */
    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ tab?: MarketTabId }>).detail;
            setTab(detail?.tab);
        };
        window.addEventListener(OPEN_MARKET_EVENT, handler);
        return () => window.removeEventListener(OPEN_MARKET_EVENT, handler);
    }, []);

    // 从设置那一行打开时，用宿主给的初始 tab。
    useEffect(() => {
        if (isOpen) setTab(initialTab);
    }, [isOpen, initialTab]);

    return (
        <ThemedDialog
            isOpen={isOpen}
            isDaylight={false}
            /*
             * xl（1160px）而不是默认的 s：
             * 横屏时要左右分栏，窄了左边那条一占右边就放不下卡片了。
             * 手机上 max-w-full 会自己收回屏幕宽度，不会溢出。
             */
            size="xl"
            title={t('options.marketPanelTitle')}
            onClose={onClose}
        >
            {/*
             * 横屏用更高的容器：双栏之后右边是独立滚动区，
             * 70vh 在横屏（本来就矮）会显得很局促。
             */}
            <div className="h-full max-h-[70vh] overflow-y-auto pr-0.5">
                <MarketPage initialTab={tab} />
            </div>
        </ThemedDialog>
    );
};

export default MarketPanel;
