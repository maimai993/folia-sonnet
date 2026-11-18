import { create } from 'zustand';
import {
    applyPhoneOrientation,
    readStoredAndroidPhoneFitOrientation,
    syncAndroidPhoneFitNative,
    writeStoredAndroidPhoneFitOrientation,
    type AndroidPhoneFitOrientation,
} from '../services/androidPhoneLayout';

// src/stores/useAndroidLayoutSettingsStore.ts
// 「强制横屏」的方向（竖屏 / 横屏）。
//
// 原来的「手机适配」总开关是废弃代码，已随 styles/androidPhoneFit.css 里那半边样式一起删掉：
// 它恒为 false、从来没有真正生效过，留着只会让「设置了却没效果」反复出现。这里只剩方向，
// 「强制横屏」与 HDR 投影的镜像读它。

type AndroidLayoutSettingsState = {
    phoneFitOrientation: AndroidPhoneFitOrientation;
    setPhoneFitOrientation: (orientation: AndroidPhoneFitOrientation) => void;
};

export const useAndroidLayoutSettingsStore = create<AndroidLayoutSettingsState>((set) => ({
    phoneFitOrientation: readStoredAndroidPhoneFitOrientation(),
    setPhoneFitOrientation: (orientation) => {
        writeStoredAndroidPhoneFitOrientation(orientation);
        applyPhoneOrientation(orientation);
        // 原生侧：横屏锁横屏，其它交回系统。
        syncAndroidPhoneFitNative(true, orientation);
        set({ phoneFitOrientation: orientation });
    },
}));
