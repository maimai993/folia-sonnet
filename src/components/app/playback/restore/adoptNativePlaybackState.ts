import type { NativeQueueState } from '../../../../services/nativeQueueBridge';
import { nativePlaybackEngine } from '../../../../services/playbackEngine/nativePlaybackEngine';
import { currentTime } from '../../../../stores/motionSignals';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { PlayerState, type SongResult } from '../../../../types';
import { getPlaybackSongKey } from '../../../../utils/appPlaybackGuards';
import { songFromMirrorEntry } from '../../../../utils/queueMirrorEntry';
import { askedSongKeyRef, makeSongCurrent, replaceShownSong } from '../currentSong';
import { noteMirrorQueueClaim } from './mirrorQueueClaim';

// 原生 → Web 的纯认领入口：队列先落地，不解析地址、不发送任何播放控制。
export const adoptNativePlaybackState = (snapshot: NativeQueueState): boolean => {
    if (!snapshot.hasSong || !snapshot.songKey) return false;
    if (snapshot.nativeMedia?.songKey && snapshot.nativeMedia.songKey !== snapshot.songKey) return false;
    const store = usePlaybackStore.getState();
    const known = new Map(store.playQueue.map(song => [getPlaybackSongKey(song), song]));
    const shells = new Set<SongResult>();
    const queue = snapshot.entries.map(entry => {
        const existing = known.get(entry.songKey);
        if (existing) return existing;
        const shell = songFromMirrorEntry(entry);
        shells.add(shell);
        return shell;
    });
    const song = queue.find(item => getPlaybackSongKey(item) === snapshot.songKey)
        ?? (store.currentSong && getPlaybackSongKey(store.currentSong) === snapshot.songKey ? store.currentSong : null);
    if (!song) return false;
    // 认领不是新播放意图，不能取消正在等待原生 ready 的用户订单。
    const changed = !store.currentSong || getPlaybackSongKey(store.currentSong) !== snapshot.songKey;
    const media = snapshot.nativeMedia;
    const sameMedia = media?.songKey === snapshot.songKey && nativePlaybackEngine.adoptSnapshot(media);
    if (queue.length > 0 && (queue.length !== store.playQueue.length
        || queue.some((item, index) => getPlaybackSongKey(item) !== getPlaybackSongKey(store.playQueue[index])))) {
        // 这份队列含有镜像条目拼的壳：登记，让会话恢复补全、持久化暂不写盘。
        noteMirrorQueueClaim(snapshot.songKey, shells);
        store.setPlayQueue(queue);
    }
    if (changed) store.setLyricsState(null);
    // 同一 MediaItem 的前台读回不是再次点歌；只更新队列中的元数据，不制造新的 ask。
    if (sameMedia && !changed && store.currentSong && askedSongKeyRef.current === snapshot.songKey) replaceShownSong(store.currentSong, song);
    else makeSongCurrent(song);
    // 歌换上之后再写封面：换歌那一下 store 会清掉上一首的封面（#323），先写就被一并清掉。
    if (changed) store.setCachedCoverUrl(snapshot.artworkUrl || null);
    // 对外地址用原始 URL：伴奏/清唱 file:// 轨只是原生内部实际加载的东西，不应把 audioSrc 换成它。
    if (media?.songKey === snapshot.songKey && media.url) store.setAudioSrc(media.baseUrl || media.url);
    store.setDuration(Math.max(0, snapshot.durationMs) / 1000);
    currentTime.set(Math.max(0, snapshot.positionMs) / 1000);
    store.setPlayerState(snapshot.playing ? PlayerState.PLAYING : PlayerState.PAUSED);
    return true;
};
