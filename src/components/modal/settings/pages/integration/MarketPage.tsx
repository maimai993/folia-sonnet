// src/components/modal/settings/pages/integration/MarketPage.tsx
//
// 「市场」设置页：背景市场与字体市场的唯一入口。
//
// 为什么收在一页：
//   · 以前字体市场散在三处（壁纸设置、歌词设置、可视化字体选择器），
//     同一件事有三个入口，行为还各不一样，改起来容易漏。
//   · 背景市场是新功能，本来就没有入口可挂。
//   现在统一在这里，两个区块的结构一致：浏览 → 选中 → 选「用在哪」。
//
// 布局分两种：
//   · 竖屏（手机常态）：上下堆叠，选项在上、卡片在下 —— 宽度就那么多，分栏没意义。
//   · 横屏（手机横放 / 平板）：左右分栏，选项收成窄窄一条放左边，
//     右边整块让给卡片网格。之前横屏也是上下堆叠，两边大片空白，看着很糟。

import React, { useEffect, useState } from 'react';
import { Button } from '../../../../../components/ui';
import { useTranslation } from 'react-i18next';
import MarketBackgroundSection from './market/MarketBackgroundSection';
import MarketFontSection from './market/MarketFontSection';

export type MarketTabId = 'background' | 'font';

interface MarketPageProps {
    /** 打开时停在哪个 tab：从字体入口进来就该直接看字体。 */
    initialTab?: MarketTabId;
}

/**
 * 横屏判定：宽高比而不是屏幕方向。
 *
 * `screen.orientation` 在部分机型上不可靠（尤其折叠屏和分屏），
 * 用容器的宽高比反而更准，而且窗口尺寸一变就能跟上。
 */
const useIsWide = (): boolean => {
    const [wide, setWide] = useState(
        typeof window !== 'undefined' ? window.innerWidth > window.innerHeight : false,
    );
    useEffect(() => {
        const update = () => setWide(window.innerWidth > window.innerHeight);
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);
    return wide;
};

const MarketPage: React.FC<MarketPageProps> = ({ initialTab }) => {
    const { t } = useTranslation();
    const [tab, setTab] = useState<MarketTabId>(initialTab ?? 'background');
    const wide = useIsWide();

    // 面板重新打开且宿主指定了 tab 时跟过去。
    React.useEffect(() => {
        if (initialTab) setTab(initialTab);
    }, [initialTab]);

    const tabs: Array<{ id: MarketTabId; labelKey: string }> = [
        { id: 'background', labelKey: 'options.marketTabBackground' },
        { id: 'font', labelKey: 'options.marketTabFont' },
    ];

    const tabButtons = (
        <div className={wide ? 'flex flex-col gap-1.5' : 'flex gap-1.5'}>
            {tabs.map((entry) => {
                const active = tab === entry.id;
                return (
                    <Button
                        key={entry.id}
                        onClick={() => setTab(entry.id)}
                        className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                            wide ? 'w-full text-left' : 'flex-1'
                        } ${
                            active
                                ? 'border-[var(--st-accent)] bg-[var(--st-accent)]/15 font-medium text-[var(--st-t1)]'
                                : 'border-[var(--st-line,rgba(255,255,255,0.12))] text-[var(--st-t2)] hover:bg-[var(--st-fill)]'
                        }`}
                    >
                        {t(entry.labelKey)}
                    </Button>
                );
            })}
        </div>
    );

    /*
     * 横屏：左窄右宽。
     *
     * 左边 = 导航 + 筛选。竖栏以前只放两个 tab，底下空成一大块；
     * 用户要的是「筛选也放左边」，右边只留挑东西的卡片。
     *
     * 两栏用的是同一组筛选状态（MarketFilterSlot 里的 store），
     * 所以左边点分类、右边立刻换卡片，不会各走各的。
     *
     * 右边 min-w-0 是关键：不加的话网格会把容器撑开、横向溢出。
     */
    if (wide) {
        return (
            <div className="flex h-full gap-4">
                <aside className="flex w-[196px] shrink-0 flex-col gap-2 overflow-y-auto pr-0.5">
                    {tabButtons}
                    <div className="mt-1 space-y-2 border-t border-[var(--st-fill2)] pt-2">
                        {tab === 'background'
                            ? <MarketBackgroundSection part="filters" />
                            : <MarketFontSection part="filters" />}
                    </div>
                </aside>
                <div className="min-w-0 flex-1 overflow-y-auto pr-0.5">
                    {tab === 'background'
                        ? <MarketBackgroundSection part="content" />
                        : <MarketFontSection part="content" />}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {tabButtons}
            {tab === 'background' ? <MarketBackgroundSection /> : <MarketFontSection />}
        </div>
    );
};

export default MarketPage;
