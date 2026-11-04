// src/hooks/useFoliaMachineCodeSync.ts
// 启动时把桌面端的 AI 连接对齐到免费渠道：服务商默认成它，机器码交给主进程。
//
// 实现放在 services/aiText.ts（「门」）里 —— 那里是唯一允许提到 AI 设置字段名的地方
// （见 test/unit/services/aiTextArchitecture.test.ts）。这里只负责在启动时调一次。

import { useEffect } from 'react';
import { seedFreeChannelOnDesktop } from '../services/aiText';

export const useFoliaMachineCodeSync = (): void => {
    useEffect(() => {
        void seedFreeChannelOnDesktop();
    }, []);
};
