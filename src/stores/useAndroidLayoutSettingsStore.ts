import { create } from 'zustand';
import {
    applyAndroidPhoneFit,
    readStoredAndroidPhoneFit,
    readStoredAndroidPhoneFitOrientation,
    readStoredAutoLandscapeForVisualizer,
    syncAndroidOrientationOverride,
    syncAndroidPhoneFitNative,
    writeStoredAndroidPhoneFit,
    writeStoredAutoLandscapeForVisualizer,
    writeStoredAndroidPhoneFitOrientation,
    type AndroidOrientationOverride,
    type AndroidPhoneFitOrientation,
} from '../services/androidPhoneLayout';

// src/stores/useAndroidLayoutSettingsStore.ts
// 「手机适配」开关。默认关闭 —— 打开后才在 <html> 上落 data-folia-phone-fit='true'，
// 由 styles/androidPhoneFit.css 接管布局；关掉时上游的桌面布局一个字节都不会变。
//
// 方向有两层：`phoneFitOrientation` 是用户的选择（「强制横屏」那一行，落盘），
// `phoneFitOrientationOverride` 是「进入可视化自动横屏」此刻压在上面的覆盖（不落盘，
// 见 useAndroidPlaybackAutoOrientation）。落盘那份永远不动 —— 覆盖是暂时的，用户打开设置
// 看到的仍是他自己选的那个方向。

type AndroidLayoutSettingsState = {
    phoneFitEnabled: boolean;
    phoneFitOrientation: AndroidPhoneFitOrientation;
    /** 「进入可视化自动横屏」开关（只有安卓画这一行）。默认关。 */
    autoLandscapeForVisualizer: boolean;
    /** 自动横屏此刻的覆盖；null = 没有覆盖，方向就是 `phoneFitOrientation`。 */
    phoneFitOrientationOverride: AndroidOrientationOverride;
    setPhoneFitEnabled: (enabled: boolean) => void;
    setPhoneFitOrientation: (orientation: AndroidPhoneFitOrientation) => void;
    setAutoLandscapeForVisualizer: (enabled: boolean) => void;
    setPhoneFitOrientationOverride: (override: AndroidOrientationOverride) => void;
};

/** 此刻真正生效的方向：覆盖压着落盘那份。 */
export const effectivePhoneFitOrientation = (state: {
    phoneFitOrientation: AndroidPhoneFitOrientation;
    phoneFitOrientationOverride: AndroidOrientationOverride;
}): AndroidPhoneFitOrientation => state.phoneFitOrientationOverride ?? state.phoneFitOrientation;

export const useAndroidLayoutSettingsStore = create<AndroidLayoutSettingsState>((set, get) => ({
    phoneFitEnabled: readStoredAndroidPhoneFit(),
    phoneFitOrientation: readStoredAndroidPhoneFitOrientation(),
    autoLandscapeForVisualizer: readStoredAutoLandscapeForVisualizer(),
    phoneFitOrientationOverride: null,
    setPhoneFitEnabled: (enabled) => {
        writeStoredAndroidPhoneFit(enabled);
        applyAndroidPhoneFit(enabled, get().phoneFitOrientation);
        // 原生侧同步：开关打开时顺带锁方向（见 PhoneLayoutOrientation）。
        syncAndroidPhoneFitNative(enabled, get().phoneFitOrientation);
        set({ phoneFitEnabled: enabled });
    },
    setPhoneFitOrientation: (orientation) => {
        writeStoredAndroidPhoneFitOrientation(orientation);
        /*
         * 第一个参数（手机适配总开关）恒为 false：那一行已经从设置里删了，这里不能再
         * 顺手把 `data-folia-phone-fit` 打开 —— 否则一个没有入口的开关会一直生效。
         * 方向属性照旧写，横屏那套缩放要看它。
         */
        applyAndroidPhoneFit(false, orientation);
        // 原生侧：横屏锁横屏，其它交回系统（PhoneLayoutOrientation 不再看总开关）。
        syncAndroidPhoneFitNative(true, orientation);
        set({ phoneFitOrientation: orientation });
        /*
         * 手动改过方向就把覆盖清掉：用户亲手拨的这一下比「现在在哪一页」新。
         * 开着自动横屏时它会按当前页面被重算一次（见 useAndroidPlaybackAutoOrientation），
         * 所以这里清掉不会让自动横屏失效 —— 只是先回到用户的选择再重新判一遍。
         */
        get().setPhoneFitOrientationOverride(null);
    },
    setAutoLandscapeForVisualizer: (enabled) => {
        writeStoredAutoLandscapeForVisualizer(enabled);
        // 关掉就把覆盖撤掉：剩下的方向重新由「强制横屏」那一行说了算。
        if (!enabled) get().setPhoneFitOrientationOverride(null);
        set({ autoLandscapeForVisualizer: enabled });
    },
    setPhoneFitOrientationOverride: (override) => {
        if (get().phoneFitOrientationOverride === override) return;
        applyAndroidPhoneFit(false, effectivePhoneFitOrientation({ ...get(), phoneFitOrientationOverride: override }));
        syncAndroidOrientationOverride(override);
        set({ phoneFitOrientationOverride: override });
    },
}));
