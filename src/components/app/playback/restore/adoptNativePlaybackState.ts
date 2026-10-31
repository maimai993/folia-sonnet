import type { NativeQueueState } from '../../../../services/nativeQueueBridge';
import { nativePlaybackEngine } from '../../../../services/playbackEngine/nativePlaybackEngine';
import { currentTime } from '../../../../stores/motionSignals';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { PlayerState, type SongResult } from '../../../../types';
import { getPlaybackSongKey } from '../../../../utils/appPlaybackGuards';
import { songFromMirrorEntry } from '../../../../utils/queueMirrorEntry';
import { makeSongCurrent } from '../currentSong';

// 原生 → Web 的纯认领入口：队列先落地，不解析地址、不发送任何播放控制。
export const adoptNativePlaybackState = (snapshot: NativeQueueState): boolean => {
    if (!snapshot.hasSong || !snapshot.songKey) return false;
    if (snapshot.nativeMedia?.songKey && snapshot.nativeMedia.songKey !== snapshot.songKey) return false;
    const store = usePlaybackStore.getState();
    const known = new Map(store.playQueue.map(song => [getPlaybackSongKey(song), song]));
    const queue = snapshot.entries.map(entry => known.get(entry.songKey) ?? songFromMirrorEntry(entry));
    const song = queue.find(item => getPlaybackSongKey(item) === snapshot.songKey)
        ?? (store.currentSong && getPlaybackSongKey(store.currentSong) === snapshot.songKey ? store.currentSong : null);
    if (!song) return false;
    // 认领不是新播放意图，不能取消正在等待原生 ready 的用户订单。
    const changed = !store.currentSong || getPlaybackSongKey(store.currentSong) !== snapshot.songKey;
    const media = snapshot.nativeMedia;
    if (media && media.songKey === snapshot.songKey) nativePlaybackEngine.adoptSnapshot(media);
    if (queue.length > 0 && (queue.length !== store.playQueue.length
        || queue.some((item, index) => getPlaybackSongKey(item) !== getPlaybackSongKey(store.playQueue[index])))) {
        store.setPlayQueue(queue);
    }
    if (changed) {
        store.setLyricsState(null);
        store.setCachedCoverUrl(snapshot.artworkUrl || null);
    }
    makeSongCurrent(song as SongResult);
    if (media?.songKey === snapshot.songKey && media.url) store.setAudioSrc(media.url);
    store.setDuration(Math.max(0, snapshot.durationMs) / 1000);
    currentTime.set(Math.max(0, snapshot.positionMs) / 1000);
    store.setPlayerState(snapshot.playing ? PlayerState.PLAYING : PlayerState.PAUSED);
    return true;
};
