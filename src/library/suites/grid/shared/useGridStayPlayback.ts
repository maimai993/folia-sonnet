import { useCallback } from 'react';
import type { SongResult } from '../../../../types';
import { PlayerState } from '../../../../types';
import type { LibraryPlaybackPort } from '../../../core/shared/ports.contract';
import { selectDisplayPlayerState, usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../../../utils/appPlaybackGuards';

// src/library/suites/grid/shared/useGridStayPlayback.ts
// 网格卡片上的播放键跟随底部控制条：正在播放的那首画成暂停 / 继续，再点就切换播放状态，
// 而不是重新「立即播放」。这个同步不再依赖「播放后进入的视图」设置——用户实测点洛雪歌曲时
// 音乐播了、底部按钮变了，卡片却还是 ▶。跳转仍由应用自己的 navigateToPlaybackView 决定。
// 只订阅两个离散值（正在播放的曲目、播放 / 暂停），播放进度不会让网格重渲染。

export type GridPlaybackMark = 'playing' | 'paused';

export const useGridStayPlayback = (playTrack: (track: SongResult, queue: SongResult[]) => void, port: Pick<LibraryPlaybackPort, 'togglePlayback'>) => {
    const currentKey = usePlaybackStore(state => (state.currentSong ? getPlaybackSongKey(state.currentSong) : null));
    const isPlaying = usePlaybackStore(state => selectDisplayPlayerState(state) === PlayerState.PLAYING);
    const toggle = port.togglePlayback;
    /**
     * 卡片要画成暂停 / 继续的那首。
     *
     * 旧实现还要求「留在原处」这个设置，结果点洛雪歌曲时音乐已经播了、底部控制条会变暂停，
     * 卡片上却一直是 ▶（用户实测三个问题里的第三个）。卡片的图标只该看「是不是正在播这首」，
     * 跟播放后跳去哪个界面无关；宿主给了播放开关就同步，没给就退回普通播放。
     */
    const markedKey = toggle ? currentKey : null;

    const markFor = useCallback((track: SongResult | undefined): GridPlaybackMark | null => (
        markedKey && track && getPlaybackSongKey(track) === markedKey ? (isPlaying ? 'playing' : 'paused') : null
    ), [isPlaying, markedKey]);

    /**
     * 卡片的「播放」：正在播放的那首切换播放状态，其余照旧交给播放端口。点的那一刻直读 store：
     * PolaroidCard 的 memo 比较不看 onSelect，卡片手里可能是早先渲染的闭包，判断不能依赖渲染时的值。
     */
    const selectTrack = useCallback((track: SongResult, queue: SongResult[]) => {
        const current = usePlaybackStore.getState().currentSong;
        if (
            toggle
            && current
            && getPlaybackSongKey(current) === getPlaybackSongKey(track)
        ) {
            toggle();
            return;
        }
        playTrack(track, queue);
    }, [playTrack, toggle]);

    return { markFor, selectTrack };
};
