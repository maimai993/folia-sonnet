import { Smartphone } from 'lucide-react';
import { defineCommand } from '../commandFactories';
import type { CommandPaletteCommand } from '../types';
import { gyroTiltSupported, requestGyroTiltPermission, useGyroSettingsStore } from '../../../stores/useGyroSettingsStore';

// src/components/command-palette/commands/gyroTiltCommand.ts
// 陀螺仪适配的开关命令（全局一份，四个 3D 背景共用）。
//
// 和设置面板那颗开关读的是同一个 store 字段，所以两处永远一致。
// 没有陀螺仪读数的设备（桌面浏览器）不出现这条命令。

export const gyroTiltCommand: CommandPaletteCommand = defineCommand({
    id: 'visual-gyro-tilt',
    group: 'settings',
    title: 'Gyroscope tilt',
    description: 'Let the camera lean with the phone across every 3D background',
    keywords: ['gyro', 'gyroscope', 'tilt', 'motion', '陀螺仪', '倾斜', '重力感应', '镜头'],
    icon: Smartphone,
    platform: ['capacitor-android'],
    execute: async () => {
        const { gyroTiltEnabled, handleToggleGyroTilt } = useGyroSettingsStore.getState();
        if (gyroTiltEnabled) {
            handleToggleGyroTilt(false);
            return true;
        }
        if (!gyroTiltSupported()) return false;
        const granted = await requestGyroTiltPermission();
        handleToggleGyroTilt(granted);
        return granted;
    },
});
