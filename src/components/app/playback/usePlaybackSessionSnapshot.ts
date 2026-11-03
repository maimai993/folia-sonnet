import { useEffect } from 'react';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { persistPlaybackCache } from './persistPlaybackCache';

// src/components/app/playback/usePlaybackSessionSnapshot.ts
//
// 会话快照：**一处写，一处读**。
//
// 原来「上次放的哪首、队列什么顺序」散在十几条业务路径里各写各的：点歌写一次、切歌写
// 一次、拖动队列写一次……只要有一条没接上（比如打乱顺序、原生接管后切歌），那份记录就
// 停在上一个动作，用户清掉后台回来看到的就是「全没了」。
//
// 这里改成订阅：当前曲或队列一换，就在一秒后把整份会话写下去，页面转后台时立刻写。
// 写的是同一份 `last_song` / `last_queue`，所以恢复那条链路不用改，只是数据不再靠
// 每一条业务路径记得「顺手存一下」。

/** 变化后等这么久再写：拖动队列、连续切歌时不必每次都序列化几百首。 */
const DEBOUNCE_MS = 1000;

export const usePlaybackSessionSnapshot = (): void => {
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;

        const flush = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            const { currentSong, playQueue } = usePlaybackStore.getState();
            // 没有歌时不动：清空队列有自己的入口（`forgetPlaybackCache`），
            // 这里跟着写一条空的会把「刚清空」和「还没开始听」搅在一起。
            if (!currentSong) return;
            void persistPlaybackCache(currentSong, playQueue);
        };

        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                flush();
            }, DEBOUNCE_MS);
        };

        const unsubscribe = usePlaybackStore.subscribe((state, prev) => {
            if (state.currentSong === prev.currentSong && state.playQueue === prev.playQueue) return;
            schedule();
        });

        // 转后台那一刻立刻写：这之后进程随时可能被系统收走，等不到那一秒。
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        const onPageHide = () => flush();

        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', onPageHide);

        return () => {
            unsubscribe();
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('pagehide', onPageHide);
            flush();
        };
    }, []);
};
