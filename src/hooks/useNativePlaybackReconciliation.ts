import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isCapacitorAndroid } from '../platform/runtime';
import { readNativeQueueState, type NativeQueueState } from '../services/nativeQueueBridge';
import { beginNativePlaybackRead, isLatestNativePlaybackRead, isNativePlaybackReconciling, setNativePlaybackReconciling, subscribeNativePlaybackSync } from '../services/playbackEngine/nativePlaybackSync';
import { subscribeBackgroundRenderSuspended } from '../utils/backgroundRenderGate';
import { playRequestsSoFar } from '../components/app/playback/currentSong';

// 挂载与唤醒串行拉取完整快照；先关回写闸门，再认领，最后允许前台继续同步。
export const useNativePlaybackReconciliation = (
    onSnapshot: (snapshot: NativeQueueState) => boolean | Promise<boolean>,
): { pending: boolean; refresh: () => void } => {
    const refreshRef = useRef<() => void>(() => undefined);
    const callback = useRef(onSnapshot);
    callback.current = onSnapshot;
    const pending = useSyncExternalStore(subscribeNativePlaybackSync, isNativePlaybackReconciling, () => false);
    useEffect(() => {
        if (!isCapacitorAndroid()) return;
        let disposed = false;
        let inFlight: Promise<void> | null = null;
        let rerun = false;
        let reconciled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let retries = 0;
        const run = (): Promise<void> => {
            if (inFlight) {
                rerun = true;
                return inFlight;
            }
            if (retryTimer) clearTimeout(retryTimer);
            reconciled = false;
            setNativePlaybackReconciling(true);
            inFlight = (async () => {
                do {
                    rerun = false;
                    const generation = beginNativePlaybackRead();
                    const requests = playRequestsSoFar();
                    const snapshot = await readNativeQueueState();
                    if (disposed || !isLatestNativePlaybackRead(generation)) return;
                    if (requests !== playRequestsSoFar()) { reconciled = true; continue; }
                    reconciled = !snapshot?.hasSong || !snapshot.nativeMedia
                        || Boolean(await callback.current(snapshot));
                } while (rerun && !disposed);
            })().catch(error => {
                console.warn('[NativePlayer] 唤醒认领失败，未发送播放控制', error);
            }).finally(() => {
                inFlight = null;
                if (disposed || document.visibilityState === 'hidden') return;
                if (!reconciled && retries++ < 3) {
                    retryTimer = setTimeout(() => { void run(); }, 100);
                    return;
                }
                retries = 0;
                setNativePlaybackReconciling(false);
            });
            return inFlight;
        };
        const foreground = () => {
            if (document.visibilityState === 'visible') void run();
        };
        const visibility = () => {
            if (document.visibilityState === 'hidden') setNativePlaybackReconciling(true);
            else foreground();
        };
        const removeBackground = subscribeBackgroundRenderSuspended(background => {
            if (background) setNativePlaybackReconciling(true);
            else void run();
        });
        refreshRef.current = () => { void run(); };
        void run();
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('focus', foreground);
        window.addEventListener('resume', foreground);
        return () => {
            disposed = true;
            if (retryTimer) clearTimeout(retryTimer);
            removeBackground();
            refreshRef.current = () => undefined;
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('focus', foreground);
            window.removeEventListener('resume', foreground);
        };
    }, []);
    return { pending, refresh: () => refreshRef.current() };
};
