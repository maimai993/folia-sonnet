import React from 'react';
import { PlayerState } from '../types';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { useScreenAwakeSettingsStore } from '../stores/useScreenAwakeSettingsStore';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { isCapacitorAndroid } from '../platform/runtime';
import { setScreenAwake } from '../platform/foliaNative';

// src/hooks/useScreenAwake.ts
// 屏幕常亮：把两个开关和播放状态折成一个布尔值交给原生。
//
// 为什么要在 Web 侧算好再过桥，而不是把两个开关都发给原生：
// 「什么算正在播」在这里才有答案（换歌那一刻、尾部渐显那一段都算在播），
// 原生那边只有一个窗口 FLAG，它开或关，不知道播放器里发生了什么。
// 让它自己判的话，切歌瞬间状态经过 IDLE 就会把常亮松开又立刻拉回来。

export const useScreenAwake = (): void => {
    // 界面设置里的总开关：开着的时候与播放状态无关，前台就一直亮。
    const alwaysAwake = useScreenAwakeSettingsStore(state => state.keepScreenAwake);
    const enabledWhilePlaying = useAudioSettingsStore(state => state.keepScreenOnWhilePlaying);
    /*
     * 用 selectDisplayPlayerState 而不是裸 playerState：
     * playSong 会把新歌的状态先置成 IDLE，而此刻正在响的还是上一首 ——
     * 读裸状态的话每换一首歌常亮就要松一下，屏幕跟着暗一下。
     */
    const playerState = usePlaybackStore(selectDisplayPlayerState);
    // 非 Android 没有实现（FLAG_KEEP_SCREEN_ON 是 Android 窗口的东西），整套都不用跑。
    // 两个开关共用一个 FLAG，取或即可：常驻开关开着时播放状态怎么变都不熄。
    const awake = isCapacitorAndroid()
        && (alwaysAwake || (enabledWhilePlaying && playerState === PlayerState.PLAYING));
    const appliedRef = React.useRef<boolean | null>(null);
    React.useEffect(() => {
        // 只在真的翻转时过桥：状态每变一次才一次，重复写同一个值没有意义。
        if (appliedRef.current === awake) {
            return;
        }
        appliedRef.current = awake;
        void setScreenAwake(awake);
    }, [awake]);
    React.useEffect(() => () => {
        // 组件卸载（退出登录、切换账号之类的边界）时把屏幕交还给系统。
        if (appliedRef.current) {
            appliedRef.current = false;
            void setScreenAwake(false);
        }
    }, []);
};

export default useScreenAwake;
