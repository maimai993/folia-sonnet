import { useEffect, useRef } from 'react';
import { runSleepTimerExpiryAction } from './sleepTimerExpiry';
import { useSleepTimerStore } from '../stores/useSleepTimerStore';
import { requestAppExit } from '../platform/foliaNative';
import { hasSleepTimerDelay, resolveSleepTimerDelayMs, type SleepTimerEndAction, type SleepTimerPlan } from '../services/sleepTimerPlan';

// src/hooks/useSleepTimer.ts

type UseSleepTimerState = {
    enabled: boolean;
    /**
     * 老的两档写法（多少小时 + 多少分钟）。
     *
     * dev 把三种方式（分钟后 / 小时后 / 到几点）合成了一个 plan，调用方改传 plan；但合并没有
     * 动 App.tsx（它给 store 的订阅快照是上游那份，只有这两个数）。所以这里两种都收：
     * 给了 plan 就按 plan 排，没给就退回「小时 + 分钟」，两条路最后都归成一个截止时刻。
     */
    hours?: number;
    minutes?: number;
    plan?: SleepTimerPlan;
    /** 到点之后干什么；不给就是暂停播放。 */
    endAction?: SleepTimerEndAction;
    onExpireFallback: () => void;
};

const TICK_MS = 1000;

/**
 * 三种方式最后都归成一个截止时刻：能用同一套倒计时，也就不必各自担 Broadcasting 一份。
 *
 * 依赖里放具体的数而不是整个 plan 对象：plan 是调用方每次渲染新建的字面量，
 * 直接依赖它会让倒计时每秒重建一次（每次都从零开始数，界面上就是纹丝不动）。
 */
export const useSleepTimer = ({ enabled, hours, minutes, plan, endAction, onExpireFallback }: UseSleepTimerState) => {
    const onExpireFallbackRef = useRef(onExpireFallback);
    const endActionRef = useRef<SleepTimerEndAction>(endAction ?? 'pause');
    const activationId = useSleepTimerStore(state => state.sleepTimerActivationId);

    useEffect(() => {
        onExpireFallbackRef.current = onExpireFallback;
    }, [onExpireFallback]);

    useEffect(() => {
        endActionRef.current = endAction ?? 'pause';
    }, [endAction]);

    // 没给 plan 时的兜底：调用方只有「小时 + 分钟」两个数，拼成 plan 的分钟那一档。
    const rawHours = plan ? plan.hours : (hours ?? 0);
    const rawMinutes = plan ? plan.minutes : (minutes ?? 0);
    const mode = plan ? plan.mode : 'minutes';
    const clockHour = plan ? plan.clockHour : 0;
    const clockMinute = plan ? plan.clockMinute : 0;

    useEffect(() => {
        // 就地拼而不用外面的 plan 对象：那是每次渲染新建的字面量，放进依赖会让倒计时每秒重建一次
        // （每次都从零开始数，界面上就是那个「明明开了却纹丝不动」的经典 bug）。
        const activePlan: SleepTimerPlan = { mode, hours: rawHours, minutes: rawMinutes, clockHour, clockMinute };
        const now = Date.now();
        if (!enabled || !hasSleepTimerDelay(activePlan, now)) {
            useSleepTimerStore.setState({ sleepTimerDeadlineMs: null });
            return;
        }

        const deadline = now + resolveSleepTimerDelayMs(activePlan, now);
        useSleepTimerStore.setState({ sleepTimerDeadlineMs: deadline });
        const timer = window.setInterval(() => {
            if (Date.now() < deadline) {
                return;
            }
            window.clearInterval(timer);
            useSleepTimerStore.setState({ sleepTimerEnabled: false, sleepTimerDeadlineMs: null });

            void runSleepTimerExpiryAction({
                endAction: endActionRef.current,
                // 「退出应用」这条路只有原生壳有：桌面 / 安卓走 requestAppExit，Web 上它自己会说退不了，
                // 于是那次到点退回暂停播放（见 sleepTimerExpiry.ts）。
                quitApp: requestAppExit,
                onFallback: () => onExpireFallbackRef.current(),
            });
        }, TICK_MS);

        return () => {
            window.clearInterval(timer);
            useSleepTimerStore.setState({ sleepTimerDeadlineMs: null });
        };
    }, [activationId, enabled, mode, rawHours, rawMinutes, clockHour, clockMinute]);
};
