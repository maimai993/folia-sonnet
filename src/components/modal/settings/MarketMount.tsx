// src/components/modal/settings/MarketMount.tsx
//
// 市场面板在设置弹窗里的挂载点，连同开合状态一起收在这个组件里。
//
// 为什么不直接写在 SettingsModal 里：
//   SettingsModal 有 800 行的上限基线，每个功能往里塞几行，
//   同步上游时就会一直撞线。所有 fork 自己的挂载点都走这种
//   「一行 <XxxMount />」的形式，上游改动落在别处时冲突面最小。
//
// 监听器必须挂在设置弹窗这一层（而不是「连接与集成」页里）：
//   设置页是按需挂载的，监听器若只写在某一页，从播放页的视频层、
//   外观页的莫奈背景点「打开市场」就没人接，表现是「点了没反应」。

import React from 'react';
import MarketPanel from './pages/integration/market/MarketPanel';
import { useMarketPanel } from './useMarketPanel';

const MarketMount: React.FC = () => {
    const market = useMarketPanel();
    return (
        <MarketPanel
            isOpen={market.isOpen}
            onClose={market.close}
            initialTab={market.initialTab}
        />
    );
};

export default MarketMount;
