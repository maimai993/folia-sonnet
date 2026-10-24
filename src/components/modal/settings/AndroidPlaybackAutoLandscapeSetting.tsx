import React from 'react';
import { Row, Toggle } from './kit';
import { useAndroidLayoutSettingsStore } from '../../../stores/useAndroidLayoutSettingsStore';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { O } from './pages/appearance/options';

// src/components/modal/settings/AndroidPlaybackAutoLandscapeSetting.tsx
// 安卓独占的「进入可视化自动横屏」：打开后，只要「播放后进入的视图」是可视化，进播放页
// 就锁横屏、离开播放页就转回竖屏（方向那一层见 useAndroidPlaybackAutoOrientation）。
//
// 这一行只管开关本身。要不要真的转由那三条一起决定（开关 + 「强制横屏」关着 + 播放后
// 进入可视化），所以这里不判「当前进的是哪个视图」—— 说明里写清楚，别让开关看着像坏了。
//
// 行由 kit 的 Row 画：标签与说明都取自 `O.autoLandscapeVisualizer` 那一条声明
// （labelKey / noteKey），说明不再铺在标签底下，而是收进「i」。

const AndroidPlaybackAutoLandscapeSetting: React.FC = () => {
    const enabled = useAndroidLayoutSettingsStore(state => state.autoLandscapeForVisualizer);
    const setEnabled = useAndroidLayoutSettingsStore(state => state.setAutoLandscapeForVisualizer);

    if (!isCapacitorAndroid()) return null;

    return (
        <Row option={O.autoLandscapeVisualizer}>
            <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
        </Row>
    );
};

export default AndroidPlaybackAutoLandscapeSetting;
