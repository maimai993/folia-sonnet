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
// 「陀螺仪适配」开关 —— 全局一份，四个 3D 背景共用。
//
// 这个开关原先住在町景里，可它要做的事情跟背景长什么样无关：手机往哪边歪，
// 镜头就跟着轻轻偏一点。粒子 / 星河 / 安魂 / 音域回响用的是同一套轨道相机
// （backgrounds/orbitStage.ts），所以开关也该是全局的。
//
// 场景（scenes/）那边转镜头读的也是这一份灵敏度，所以滑块放在这、放一处就够。

const GYRO_GROUP: SettingsGroupDef = { id: 'bg-gyro-tilt', titleKey: 'options.gyroTiltSettings' };

/**
 * 可以单独关掉陀螺仪的背景。
 *
 * 场景是同一个入口（'scenes'），因为场景内部共用 sceneSignals 那一套转镜头，
 * 拆到每个场景各给一个开关反而让人找不着。
 */
const GYRO_MODES = [
    { mode: 'scenes', labelKey: 'options.gyroModeScenes' },
    { mode: 'particles', labelKey: 'options.gyroModeParticles' },
    { mode: 'sonic', labelKey: 'options.gyroModeSonic' },
    { mode: 'machi', labelKey: 'options.gyroModeMachi' },
] as const;

interface GyroTiltSettingsCardProps {
    t: (key: string) => string;
}

const GyroTiltSettingsCard: React.FC<GyroTiltSettingsCardProps> = ({ t }) => {
    const gyroTiltEnabled = useGyroSettingsStore(state => state.gyroTiltEnabled);
    const toggle = useGyroSettingsStore(state => state.handleToggleGyroTilt);
    const gyroTiltGain = useGyroSettingsStore(state => state.gyroTiltGain);
    const setGain = useGyroSettingsStore(state => state.handleSetGyroTiltGain);
    const perMode = useGyroSettingsStore(state => state.gyroTiltPerMode);
    const setForMode = useGyroSettingsStore(state => state.handleSetGyroTiltForMode);
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
             * 单独关掉某个背景。没配过就是「跟随全局」，所以 checked 取 ?? true：
             * 全局开着的时候这些默认都是开的，用户点一下就只关这一个。
             */}
            {GYRO_MODES.map(({ mode, labelKey }) => (
                <ToggleRow
                    key={mode}
                    label={t(labelKey)}
                    checked={perMode[mode] ?? true}
                    disabled={!supported || !gyroTiltEnabled}
                    onChange={enable => setForMode(mode, enable)}
                    note={mode === 'scenes' ? t('options.gyroTiltPerModeHint') : undefined}
                />
            ))}
        </Group>
    );
};

export default GyroTiltSettingsCard;
