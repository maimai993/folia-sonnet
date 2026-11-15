import { useEffect, useRef } from 'react';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import type { SongResult } from '../types';

// src/hooks/useSongThemeFollow.ts
// 当前曲目一变就把这首歌的主题恢复出来。**不再依赖「走哪条路径切的歌」**。
//
// 原来 `restoreCachedThemeForSong` 只在三条路上被调用：playSong 的 Web 全流程、原生
// syncTo 的认领、会话恢复。原生派发的点歌绕过前两条（playFromQueue 之后直接 return，
// 而那条路不发 syncTo），于是「切了歌单，主题还停在上一个歌单那首，要等下一首才翻」。
//
// 现在改成按 **songKey 变化** 这一个判据驱动：不管这次切歌是谁发起、走哪条链路，
// 只要当前曲目换了，就把主题换成它该有的。这正是用户说的「前台只负责拉数据、渲染」——
// 它不该知道播放是怎么发生的，只该对「现在放的是哪首」作出反应。

/**
 * 这一次重渲染要不要去恢复主题。
 *
 * 抽成纯函数是因为这里的判据错一次就会表现为「主题一直闪」（判松了）或
 * 「切歌不换主题」（判紧了），而两种在真机上都很难看出是这一行的问题。
 *
 * @param previousKey 上一次处理过的曲目身份（null 表示还没处理过任何曲目）
 * @param currentKey  当前曲目的身份（null 表示当前没有曲目）
 */
export const shouldRestoreSongTheme = (
    previousKey: string | null,
    currentKey: string | null,
): boolean => {
    // 没有曲目：不做事，但也不把 previousKey 当已经处理过 —— 见下面的重置规则。
    if (!currentKey) return false;
    return currentKey !== previousKey;
};

/** 没有当前曲目时，记下的「上一首」应当清空，好让同一首再播时重新恢复主题。 */
export const nextTrackedSongKey = (
    currentKey: string | null,
): string | null => (currentKey ? currentKey : null);

type SongThemeFollowOptions = {
    currentSong: SongResult | null;
    /** 恢复这首歌的主题（useThemeController 的 restoreCachedThemeForSong）。 */
    restoreCachedThemeForSong: (song: SongResult) => Promise<unknown>;
};

export const useSongThemeFollow = ({
    currentSong,
    restoreCachedThemeForSong,
}: SongThemeFollowOptions): void => {
    // 记住上一次处理过哪首：同一个 songKey 重渲染不该反复拉主题（那会一直闪）。
    const lastKeyRef = useRef<string | null>(null);
    // 恢复是异步的，期间可能又换歌；用序号作废过期的结果。
    const callSeqRef = useRef(0);
    /*
     * 恢复函数**只走 ref，不进依赖数组**。
     *
     * useThemeController 里它是普通 async 函数、没有 useCallback：每次渲染都是新引用。
     * 把它放进依赖就等于「每渲染必跑一次 effect」，而恢复成功会写主题状态 → 再渲染 →
     * 再跑 …… 有当前曲目时这是一个不会停的循环，表现就是**开着歌一进 App 就黑屏**
     * （重开也黑，因为曲目是持久化的）。
     *
     * 判据只有一个：songKey 变了才恢复。函数换了新引用不算变化。
     */
    const restoreRef = useRef(restoreCachedThemeForSong);
    useEffect(() => {
        restoreRef.current = restoreCachedThemeForSong;
    }, [restoreCachedThemeForSong]);

    const songKey = currentSong ? getPlaybackSongKey(currentSong) : null;

    useEffect(() => {
        const song = currentSong;
        if (!song || !songKey) {
            // 播放停了：清掉记下的那首，这样同一首再播时会重新恢复一次主题
            // （用户可能在这期间改过主题，再用缓存就不对了）。
            lastKeyRef.current = nextTrackedSongKey(null);
            return;
        }
        if (!shouldRestoreSongTheme(lastKeyRef.current, songKey)) return;
        lastKeyRef.current = songKey;
        const seq = (callSeqRef.current += 1);
        void (async () => {
            try {
                await restoreRef.current(song);
            } catch (error) {
                // 主题加载失败不影响播放：保持当前主题即可。
                console.warn('[songThemeFollow] 恢复主题失败', error);
                return;
            }
            if (seq !== callSeqRef.current) {
                // 这期间又换歌了：让新一次去纠正，这里不重复写。
                return;
            }
        })();
        // currentSong 的对象引用会随 store 派生变化，判据只认 songKey（见上）。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [songKey]);
};
