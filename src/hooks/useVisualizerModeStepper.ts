import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsUiStore } from '../stores/useSettingsUiStore';
import { getVisualizerModeLabel } from '../components/visualizer/registry';
import type { VisualizerMode } from '../types';

// src/hooks/useVisualizerModeStepper.ts
// 面板里用箭头逐个切换歌词动画。两件事必须处理：
// 1. 每步都弹一次切换提示会刷屏，所以步进时静音，停下来之后只提示最终结果。
// 2. 切到商籁会先弹性能确认框并中止切换；用户取消后要跳过它继续沿原方向走，不能把人卡在那一格。

const STEP_NOTIFY_DELAY_MS = 700;

/** 在有序模式列表里从 fromMode 沿 direction 走一格，首尾相接。 */
const stepFrom = (fromMode: VisualizerMode, direction: -1 | 1, modes: VisualizerMode[]) => {
    if (modes.length === 0) {
        return fromMode;
    }

    const index = modes.indexOf(fromMode);
    if (index < 0) {
        return modes[0];
    }

    return modes[(index + direction + modes.length) % modes.length];
};

export const useVisualizerModeStepper = (modes: VisualizerMode[]) => {
    const { t } = useTranslation();
    const sonnetWarningOpen = useSettingsUiStore(state => state.sonnetPerformanceWarningOpen);
    const modesRef = useRef(modes);
    const notifyTimerRef = useRef<number | null>(null);
    const pendingDirectionRef = useRef<-1 | 1 | null>(null);
    const pendingTargetRef = useRef<VisualizerMode | null>(null);
    const wasSonnetWarningOpenRef = useRef(sonnetWarningOpen);

    modesRef.current = modes;

    const scheduleNotify = useCallback(() => {
        if (notifyTimerRef.current !== null) {
            window.clearTimeout(notifyTimerRef.current);
        }

        notifyTimerRef.current = window.setTimeout(() => {
            notifyTimerRef.current = null;
            pendingDirectionRef.current = null;
            pendingTargetRef.current = null;

            const state = useSettingsUiStore.getState();
            state.statusSetter?.({
                type: 'info',
                text: t('notifications.visualizerSwitched', {
                    mode: getVisualizerModeLabel(state.visualizerMode, key => t(key)),
                }),
            });
        }, STEP_NOTIFY_DELAY_MS);
    }, [t]);

    const step = useCallback((direction: -1 | 1) => {
        const availableModes = modesRef.current;
        if (availableModes.length < 2) {
            return;
        }

        const state = useSettingsUiStore.getState();
        if (state.sonnetPerformanceWarningOpen) {
            return;
        }

        const target = stepFrom(state.visualizerMode, direction, availableModes);
        pendingDirectionRef.current = direction;
        pendingTargetRef.current = target;
        state.handleSetVisualizerMode(target, { notify: false });
        scheduleNotify();
    }, [scheduleNotify]);

    // 性能确认框关闭后，如果模式没变说明用户取消了，跳过这一格继续走。
    useEffect(() => {
        const wasOpen = wasSonnetWarningOpenRef.current;
        wasSonnetWarningOpenRef.current = sonnetWarningOpen;

        if (!wasOpen || sonnetWarningOpen) {
            return;
        }

        const direction = pendingDirectionRef.current;
        const rejectedMode = pendingTargetRef.current;
        if (direction === null || rejectedMode === null) {
            return;
        }

        const state = useSettingsUiStore.getState();
        if (state.visualizerMode === rejectedMode) {
            return;
        }

        const next = stepFrom(rejectedMode, direction, modesRef.current);
        if (next === state.visualizerMode || next === rejectedMode) {
            pendingDirectionRef.current = null;
            pendingTargetRef.current = null;
            return;
        }

        pendingTargetRef.current = next;
        state.handleSetVisualizerMode(next, { notify: false });
        scheduleNotify();
    }, [scheduleNotify, sonnetWarningOpen]);

    useEffect(() => () => {
        if (notifyTimerRef.current !== null) {
            window.clearTimeout(notifyTimerRef.current);
        }
    }, []);

    return step;
};
