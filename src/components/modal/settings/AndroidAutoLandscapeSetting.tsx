import React from 'react';
import { Row, Toggle } from './kit';
import { useAndroidPlaybackOrientationStore } from '../../../stores/useAndroidPlaybackOrientationStore';
import type { SettingsOptionDef } from './kit';

// src/components/modal/settings/AndroidAutoLandscapeSetting.tsx
// 安卓独占的「进入可视化自动横屏」：打开后进播放页就锁横屏，离开播放页还回去。
//
// 放在**播放控制 → 播放行为**里，不是外观：它只在播放时生效，和自动跳过、防止休眠
// 是一类东西。
//
// 判定不在这里：开关只是把这个意图写进原生设置，转不转屏由
// PhoneLayoutOrientation.resolve 按设置与实际所在页面决定。Web 这边只说「我在播放页」，
// 不说「你该转」。两处各判一次会静默分歧 —— 之前那版正是这样，真机上开了没反应。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

type Props = { def: SettingsOptionDef };

const AndroidAutoLandscapeSetting: React.FC<Props> = ({ def }) => {
    const enabled = useAndroidPlaybackOrientationStore(state => state.autoLandscapeForVisualizer);
    const setEnabled = useAndroidPlaybackOrientationStore(state => state.setAutoLandscapeForVisualizer);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <Row option={def}>
            <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
        </Row>
    );
};

export default AndroidAutoLandscapeSetting;
