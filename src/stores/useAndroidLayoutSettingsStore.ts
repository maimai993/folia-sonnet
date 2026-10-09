import { create } from 'zustand';
import {
    applyAndroidPhoneFit,
    readStoredAndroidPhoneFit,
    readStoredAndroidPhoneFitOrientation,
    syncAndroidPhoneFitNative,
    writeStoredAndroidPhoneFit,
    writeStoredAndroidPhoneFitOrientation,
    type AndroidPhoneFitOrientation,
} from '../services/androidPhoneLayout';

// src/stores/useAndroidLayoutSettingsStore.ts
// 「手机适配」开关。默认关闭 —— 打开后才在 <html> 上落 data-folia-phone-fit='true'，
// 由 styles/androidPhoneFit.css 接管布局；关掉时上游的桌面布局一个字节都不会变。

type AndroidLayoutSettingsState = {
    phoneFitEnabled: boolean;
    phoneFitOrientation: AndroidPhoneFitOrientation;
    setPhoneFitEnabled: (enabled: boolean) => void;
    setPhoneFitOrientation: (orientation: AndroidPhoneFitOrientation) => void;
};

export const useAndroidLayoutSettingsStore = create<AndroidLayoutSettingsState>((set, get) => ({
    phoneFitEnabled: readStoredAndroidPhoneFit(),
    phoneFitOrientation: readStoredAndroidPhoneFitOrientation(),
    setPhoneFitEnabled: (enabled) => {
        writeStoredAndroidPhoneFit(enabled);
        applyAndroidPhoneFit(enabled, get().phoneFitOrientation);
        // 原生侧同步：开关打开时顺带锁方向（见 PhoneLayoutOrientation）。
        syncAndroidPhoneFitNative(enabled, get().phoneFitOrientation);
        set({ phoneFitEnabled: enabled });
    },
    setPhoneFitOrientation: (orientation) => {
        writeStoredAndroidPhoneFitOrientation(orientation);
        applyAndroidPhoneFit(get().phoneFitEnabled, orientation);
        syncAndroidPhoneFitNative(get().phoneFitEnabled, orientation);
        set({ phoneFitOrientation: orientation });
    },
}));
