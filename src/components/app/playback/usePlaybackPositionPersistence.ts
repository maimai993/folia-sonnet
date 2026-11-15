import { useEffect } from 'react';
import { nativePlaybackEngine } from '../../../services/playbackEngine/nativePlaybackEngine';
import { currentTime } from '../../../stores/motionSignals';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { PlayerState } from '../../../types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { savePlaybackPosition } from './playbackPositionCache';

// src/components/app/playback/usePlaybackPositionPersistence.ts
//
// 记下「听到哪儿了」。
//
// 原来只存了「哪一首 + 整份队列」，所以重开应用歌是对的，秒数永远是 0:00；这里补那一个数。
//
// 写盘节奏刻意压得低（10 秒一次，位置没动够 2 秒不写）：
//   · 一条记录几十字节、一次 IndexedDB 事务几毫秒，但它每首歌都在发生，
//     后台放一晚上就是几百次写，没必要；
//   · 丢 10 秒对「接着听」无感，而每帧写一次等于把 IO 摊进播放路径。
// 页面转入后台时立刻补一次：那之后 rAF 不再跑，定时器也会被系统降频。

/** 定时落盘的间隔。 */
const SAVE_INTERVAL_MS = 10_000;
/** 位置比上次存下的前进不足这么多秒就不写（暂停时定时器空转）。 */
const MIN_DELTA_SEC = 2;
/** 太靠近开头的位置不值得存：从 0 开始与从 1.5 秒开始没有区别。 */
const MIN_POSITION_SEC = 3;

/**
 * 当前听到的秒数。
 *
 * 原生接管时问引擎（按物理时钟外推，后台也算得准），否则读 `<audio>` 那一路每帧写入的
 * motion signal。两者语义都是「已经听到这里」，可以直接比。
 */
const readPositionSec = (): number => {
    if (nativePlaybackEngine.ownsPlayback()) {
        const nativeSec = nativePlaybackEngine.getPositionSec();
        // 引擎接管了但还没拿到自己的快照（刚装源那一拍）会给 0：这时别急着当「听到 0 秒」，
        // 退回 `<audio>` 那一路的时钟，否则这一拍的位置就白丢了。
        if (Number.isFinite(nativeSec) && nativeSec > 0) return nativeSec;
    }
    return currentTime.get();
};

export const usePlaybackPositionPersistence = (): void => {
    useEffect(() => {
        let lastSavedSec = Number.NaN;
        let lastSongKey: string | null = null;
        let timer: ReturnType<typeof setInterval> | null = null;

        const flush = (force: boolean) => {
            const { currentSong, duration, playerState } = usePlaybackStore.getState();
            if (!currentSong) return;
            const position = readPositionSec();
            if (!Number.isFinite(position) || position < MIN_POSITION_SEC) return;
            // 停着的时候位置本来就不动，读了也没意义 —— 除了「刚暂停」那一拍，
            // 那一拍由状态变化直接触发，不用定时器兜。
            if (!force && playerState !== PlayerState.PLAYING) return;

            const songKey = getPlaybackSongKey(currentSong);
            if (songKey === lastSongKey && Math.abs(position - lastSavedSec) < MIN_DELTA_SEC) return;

            lastSongKey = songKey;
            lastSavedSec = position;
            // 写失败（配额、隐私模式）不该冒出来打扰播放：下一次 tick 会再试。
            void savePlaybackPosition(currentSong, position, duration).catch(() => undefined);
        };

        const startTimer = () => {
            if (timer !== null) return;
            timer = setInterval(() => flush(false), SAVE_INTERVAL_MS);
        };
        const stopTimer = () => {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        };

        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                flush(true);
                // 后台不再空转：每次 tick 都要读一次 store、比一次时间，而这时
                // 位置本来就靠原生引擎外推，真要记也等回到前台再说。
                stopTimer();
            } else {
                startTimer();
            }
        };

        // `pagehide` 兜「直接杀掉 WebView / 切走再也没回来」那一类：visibilitychange
        // 通常会先到，但 WebView 不保证顺序。
        const onPageHide = () => flush(true);

        // 暂停那一刻专门记一次：之后定时器不再写，而用户很可能就此离开。
        const unsubscribe = usePlaybackStore.subscribe((state, prev) => {
            const wasPlaying = prev.playerState === PlayerState.PLAYING;
            const isPlaying = state.playerState === PlayerState.PLAYING;
            if (wasPlaying && !isPlaying) flush(true);
        });

        startTimer();
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', onPageHide);

        return () => {
            stopTimer();
            unsubscribe();
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('pagehide', onPageHide);
            flush(true);
        };
    }, []);
};
