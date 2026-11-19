import { create } from 'zustand';

// 会话位置只在确认恢复了哪个音源时交接；原生与 <audio> 不共享一份未标记的秒数。
export type SessionResume = {
    songKey: string;
    url: string;
    seconds: number;
    stillWanted: () => boolean;
    /** 已经排过一次 seek：前台不能换一代播放器再补它。 */
    sourceToken?: string;
};

type ResumeState = {
    // 只在发布新位置时唤醒装源 effect。消费或取消不是一次新的装源/重试请求。
    revision: number;
    pending: SessionResume | null;
};

export const usePendingResumeStore = create<ResumeState>(() => ({ revision: 0, pending: null }));

export function publishNativeResume(resume: SessionResume) {
    usePendingResumeStore.setState(state => ({ pending: resume, revision: state.revision + 1 }));
}

export function takeNativeResume() {
    const { pending } = usePendingResumeStore.getState();
    if (pending) usePendingResumeStore.setState({ pending: null });
    return pending;
}

// 保留非会话的 current 读写协议；会话的位置只在读取时意图仍有效才可见。
export function createResumeTimeRef() {
    let value: number | null = null;
    let valid: (() => boolean) | null = null;
    return {
        get current(): number | null { return !valid || valid() ? value : null; },
        set current(next: number | null) { value = next; valid = null; },
        setSessionPosition(seconds: number, stillWanted: () => boolean) { value = seconds; valid = stillWanted; },
    };
}

// 原生分流的 next/prev 不一定经过 startPlay；读盘、准备音源、排队的 seek 都须让位。
let playbackIntent = 0;
export const resumeIntentAtStart = () => playbackIntent;
export function cancelSessionResume() {
    playbackIntent += 1;
    takeNativeResume();
}
