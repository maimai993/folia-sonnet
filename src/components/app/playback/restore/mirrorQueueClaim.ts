import type { SongResult } from '../../../../types';
import { wholeQueueWritesSoFar } from '../../../../services/wholeQueueWrites';
import { setPlayQueue, usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { resumeIntentAtStart } from '../../../../stores/usePendingResumeStore';
import { getPlaybackSongKey } from '../../../../utils/appPlaybackGuards';
import { playRequestsSoFar, replaceShownSong } from '../currentSong';
import { queueStartsSoFar } from '../start/queueStarts';

// src/components/app/playback/restore/mirrorQueueClaim.ts
//
// 启动时认领原生仍在播的歌，会把 playQueue 换成镜像条目拼的“壳”（只有歌名/歌手/封面）。
// 会话恢复随后要把磁盘上的完整队列补回来；这里记下哪些条目是壳，供三方协调：
//   · 恢复：只给仍在队列中的壳补字段，不重拉音源，不撤销加入、删除、重排或曲库刷新；
//   · 持久化：认领有效时不许写盘，否则会把磁盘完整队列覆盖成壳；
//   · 用户整表替换、切换模式或发起新播放：不再补、也不再拦截。
// 一次进程启动只有一次会话恢复，恢复收尾时 `settleMirrorQueueClaim` 之后不再登记。

type Claim = { songKey: string; shells: Set<SongResult>; stillOwnsQueue: () => boolean };

let armed = true;
let claim: Claim | null = null;

/** 登记认领时新建的镜像壳，不登记已知的完整条目。 */
export const noteMirrorQueueClaim = (songKey: string, shells: Set<SongResult>): void => {
    if (!armed || shells.size === 0) return;
    const writes = wholeQueueWritesSoFar();
    const starts = queueStartsSoFar();
    const requests = playRequestsSoFar();
    const intent = resumeIntentAtStart();
    claim = {
        songKey,
        shells,
        stillOwnsQueue: () => wholeQueueWritesSoFar() === writes && queueStartsSoFar() === starts
            && playRequestsSoFar() === requests && resumeIntentAtStart() === intent,
    };
};

/** 仍然有效的认领：当前曲没变，且没有新队列或播放意图取代它。 */
export const standingMirrorQueueClaim = (songKey: string): Claim | null => {
    if (claim?.songKey !== songKey || !claim.stillOwnsQueue()) return null;
    const { currentSong } = usePlaybackStore.getState();
    return currentSong && getPlaybackSongKey(currentSong) === songKey ? claim : null;
};

/** 持久化用：认领仍有效，暂时不写会话缓存。 */
export const holdsUnmergedMirrorQueue = (): boolean => claim !== null && standingMirrorQueueClaim(claim.songKey) !== null;

/** 按现有队列的顺序补全镜像壳；新加入或刷新的完整条目原样保留。 */
export const mergeDiskQueueIntoClaim = (songKey: string, disk: SongResult[]): void => {
    const standing = standingMirrorQueueClaim(songKey);
    if (!standing) return;
    const byKey = new Map(disk.map(song => [getPlaybackSongKey(song), song]));
    const { currentSong: shown, playQueue } = usePlaybackStore.getState();
    const enrich = (song: SongResult) => standing.shells.has(song) ? byKey.get(getPlaybackSongKey(song)) ?? song : song;
    setPlayQueue(playQueue.map(enrich));
    if (shown) {
        const full = enrich(shown);
        if (full !== shown) replaceShownSong(shown, full);
    }
};

/** 恢复收尾（补全完成、放弃或失败）：解除拦截，之后的认领不再登记。 */
export const settleMirrorQueueClaim = (): void => {
    armed = false;
    claim = null;
};

/** 仅测试：模拟新的进程启动。 */
export const armMirrorQueueClaims = (): void => {
    armed = true;
    claim = null;
};
