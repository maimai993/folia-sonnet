import React from 'react';
import { Group, type SettingsGroupDef } from '../../modal/settings/kit';
import { SliderRow, ToggleRow, times } from '../panelRows';
import {
    GYRO_TILT_GAIN_MAX,
    GYRO_TILT_GAIN_MIN,
    gyroTiltSupported,
    requestGyroTiltPermission,
    useGyroSettingsStore,
} from '../../../stores/useGyroSettingsStore';

// src/components/visualizer/backgrounds/GyroTiltSettingsCard.tsx
// 「陀螺仪适配」开关 —— 全局一份，所有画面共用。
//
// 这个开关原先住在町景里，可它要做的事情跟背景长什么样无关：手机往哪边歪，
// 镜头就跟着轻轻偏一点。所有 3D 背景（町景 / 粒子 / 音域回响）用的是同一套轨道相机
// （backgrounds/orbitStage.ts），场景（scenes/）那边转镜头读的也是这一份，
// 所以开关与灵敏度只有这一处。
//
// 它不按背景区分：开着就在每个画面里都生效，关掉才是唯一的「不生效」（issue #429）。

const GYRO_GROUP: SettingsGroupDef = { id: 'bg-gyro-tilt', titleKey: 'options.gyroTiltSettings' };

interface GyroTiltSettingsCardProps {
    t: (key: string) => string;
}

const GyroTiltSettingsCard: React.FC<GyroTiltSettingsCardProps> = ({ t }) => {
    const gyroTiltEnabled = useGyroSettingsStore(state => state.gyroTiltEnabled);
    const toggle = useGyroSettingsStore(state => state.handleToggleGyroTilt);
    const gyroTiltGain = useGyroSettingsStore(state => state.gyroTiltGain);
    const setGain = useGyroSettingsStore(state => state.handleSetGyroTiltGain);
    const supported = gyroTiltSupported();

    const handleChange = async (enable: boolean) => {
        if (!enable) {
            toggle(false);
            return;
        }
        /*
         * iOS 要求在用户手势里问权限，所以权限请求必须挂在这个点击上，
         * 不能放到背景初始化时去要。没拿到就当没开（开关回弹）。
         */
        const granted = await requestGyroTiltPermission();
        toggle(granted);
    };

    return (
        <Group def={GYRO_GROUP}>
            <ToggleRow
                label={t('options.gyroTilt')}
                note={supported ? t('options.gyroTiltHint') : t('options.gyroTiltUnsupported')}
                checked={gyroTiltEnabled}
                disabled={!supported}
                onChange={enable => { void handleChange(enable); }}
            />
            {/* 没开的时候调灵敏度看不出效果，所以跟着开关一起灰掉。 */}
            <SliderRow
                label={t('options.gyroTiltGain')}
                value={gyroTiltGain}
                min={GYRO_TILT_GAIN_MIN}
                max={GYRO_TILT_GAIN_MAX}
                step={0.1}
                format={times}
                disabled={!supported || !gyroTiltEnabled}
                onChange={setGain}
                note={t('options.gyroTiltGainHint')}
            />
            {/*
             * 这里原来还有一排「按背景单独关」的开关。现在所有画面都吃同一份读数 ——
             * 那排开关只会让人在某个背景里莫名其妙地转不动（issue #429），已经删掉。
             */}
        </Group>
    );
};

export default GyroTiltSettingsCard;
