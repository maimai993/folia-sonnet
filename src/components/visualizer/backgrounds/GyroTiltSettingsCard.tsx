import React from 'react';
import { Group, type SettingsGroupDef } from '../../modal/settings/kit';
import { ToggleRow } from '../panelRows';
import {
    gyroTiltSupported,
    requestGyroTiltPermission,
    useGyroSettingsStore,
} from '../../../stores/useGyroSettingsStore';

// src/components/visualizer/backgrounds/GyroTiltSettingsCard.tsx
// 「陀螺仪适配」开关 —— 全局一份，四个 3D 背景共用。
//
// 这个开关原先住在町景里，可它要做的事情跟背景长什么样无关：手机往哪边歪，
// 镜头就跟着轻轻偏一点。粒子 / 星河 / 安魂 / 音域回响用的是同一套轨道相机
// （backgrounds/orbitStage.ts），所以开关也该是全局的。

const GYRO_GROUP: SettingsGroupDef = { id: 'bg-gyro-tilt', titleKey: 'options.gyroTiltSettings' };

interface GyroTiltSettingsCardProps {
    t: (key: string) => string;
}

const GyroTiltSettingsCard: React.FC<GyroTiltSettingsCardProps> = ({ t }) => {
    const gyroTiltEnabled = useGyroSettingsStore(state => state.gyroTiltEnabled);
    const toggle = useGyroSettingsStore(state => state.handleToggleGyroTilt);
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
        </Group>
    );
};

export default GyroTiltSettingsCard;
