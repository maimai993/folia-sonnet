import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getFromCache, getLocalSongs } from '../../../../services/db';
import { getLocalLibraryCatalogSnapshot } from '../../../../services/localLibraryEntityRepository';
import { buildLocalQueue } from '../../../../services/playbackAdapters';
import { prefetchNearbySongs } from '../../../../services/prefetchService';
import { reportYieldedQueue, wholeQueueWritesSoFar } from '../../../../services/wholeQueueWrites';
import type { ThemeCacheSongKey } from '../../../../services/themeCache';
import { useOnlineProviderAccountStore } from '../../../../stores/useOnlineProviderAccountStore';
import { restorePlaybackSourceForSong, type RestorePlaybackSourceOutcome } from './restorePlaybackSource';
import { getPlaybackSongKey, isStagePlaybackSong, normalizePlaybackSongSource } from '../../../../utils/appPlaybackGuards';
import type { LyricData, SongResult, StatusMessage } from '../../../../types';
import type { AudioQualityPreference, MediaId } from '../../../../types/onlineMusic';
import { setStatusMessage as setStatusMsg } from '../../../../stores/useStatusMessageStore';
import { setPlayQueue, usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { askedSongKeyRef, keepSongsOfProvidersStanding, makeSongCurrent, providerDropsSoFar, startRestore } from '../currentSong';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { isRestoredSongPlayable } from '../playableSong';
import { releaseUnclaimedHifiTrack } from '../../../../services/hifi/hifiPlayback';
import { readNativeQueueState } from '../../../../services/nativeQueueBridge';
import { adoptNativePlaybackState } from './adoptNativePlaybackState';
import { getPositionWriteProbe, readPlaybackPositionForSong, savePlaybackPosition } from '../playbackPositionCache';
import { orderQueueLikeMirror, songFromMirrorEntry } from '../../../../utils/queueMirrorEntry';

// src/components/app/playback/restore/useSessionRestoreController.ts

type SetState<T> = Dispatch<SetStateAction<T>>;

type UseSessionRestoreControllerParams = {
    userId?: MediaId;
    blobUrlRef: MutableRefObject<string | null>;
    currentOnlineAudioUrlFetchedAtRef: MutableRefObject<number | null>;
    setLyrics: (nextLyrics: LyricData | null) => void;
    /*
     * 结果类型只写 `unknown`，不抄那串字面量并集：这里只是把回调往下一路传，并不按返回值
     * 分支。抄一遍的话，`restoreCachedThemeForSong` 每多一种结果（例如「本机改过」与「云端缓
     * 存」这两种）都会让这里编译不过，而它其实根本不关心是哪种。
     */
    restoreCachedThemeForSong: (songId: ThemeCacheSongKey | SongResult, options?: {
        allowLastUsedFallback?: boolean;
        preserveCurrentOnMiss?: boolean;
    }) => Promise<unknown>;
    persistLastPlaybackCache: (song: SongResult | null, queue: SongResult[]) => Promise<void>;
    clearPersistedStagePlaybackCache: () => Promise<void>;
    loadLocalSongs: () => Promise<void>;
    loadLocalPlaylists: () => Promise<void>;
    canRestoreSession?: boolean;
    /**
     * 上次听到哪儿：恢复出来的这一首从那个位置起播。
     *
     * 走 `<audio>` 与原生两条路的约定不同（前者由 `onLoadedMetadata` 消费、后者在 `setSource`
     * 时带走），但两边读的是同一个 ref，所以这里只管把秒数放进去。
     */
    pendingResumeTimeRef: MutableRefObject<number | null>;
    /**
     * The autoplay intent the audio bridge spends when a source lands. Restore normally leaves it
     * alone so the session comes back paused; the lab switch below is the only thing that arms it.
     */
    shouldAutoPlayRef: MutableRefObject<boolean>;
    /**
     * 「进入应用后自动播放」下面那一项：起播的同时把页面切到歌词页。
     * 只在这一处按开关调；不跳的时候首页照旧。
     */
    jumpToPlayerOnLaunch?: () => void;
};

// Restores the main playback session without pushing more boot logic into App.tsx.
export function useSessionRestoreController({
    userId,
    blobUrlRef,
    currentOnlineAudioUrlFetchedAtRef,
    setLyrics,
    restoreCachedThemeForSong,
    persistLastPlaybackCache,
    clearPersistedStagePlaybackCache,
    loadLocalSongs,
    loadLocalPlaylists,
    canRestoreSession = true,
    shouldAutoPlayRef,
    pendingResumeTimeRef,
    jumpToPlayerOnLaunch,
}: UseSessionRestoreControllerParams) {
    const audioQuality = useAudioSettingsStore(state => state.audioQuality);

    const hasInitializedRef = useRef(false);
    const hasLoadedLocalLibraryRef = useRef(false);
    // The whole-queue writes when the App first rendered, before the commit in which it hands mods
    // replaceQueue (useFoliumHostActions). Not read when the restore starts: on the desktop that waits for
    // the window handoff check, and a mod's replacement meanwhile would then be written over.
    const queueWritesAtMountRef = useRef(wholeQueueWritesSoFar());

    useEffect(() => {
        if (hasLoadedLocalLibraryRef.current) {
            return;
        }

        hasLoadedLocalLibraryRef.current = true;
        void loadLocalSongs();
        void loadLocalPlaylists();
    }, [loadLocalPlaylists, loadLocalSongs]);

    useEffect(() => {
        if (!canRestoreSession) {
            return;
        }

        if (hasInitializedRef.current) {
            return;
        }
        hasInitializedRef.current = true;

        // 一次就够：恢复没落地时只补跑一次，免得在这儿转圈。
        let retriedOnce = false;
        const restoreSession = async () => {
            // A mod may replace the whole queue while the session is read (from its `activate`): its queue
            // then stands over the remembered one, and is what gets saved and fetched around. The song
            // itself is restored all the same.
            const writesAtStart = queueWritesAtMountRef.current;
            const rewritten = () => wholeQueueWritesSoFar() !== writesAtStart;
            /*
             * 恢复过程的自检留痕。
             *
             * 这条链路只在真机上跑一次、失败时界面就是空的，日志又拿不到，所以把「读到了什么、
             * 停在哪一步」攒成一条提示：出问题时用户截图就能定位，不用再靠猜。
             */
            const report: string[] = [];
            let reportStage = '未走完';
            // 有没有把「上一个窗口留在 mpv 里的那首」交出去：交出去了它就归这次恢复管，
            // 没交出去（没恢复任何东西）它就是无主的，finally 里要放掉。
            let handedToSourceRestore = false;
            try {
                // WebView 重建不等于播放器重启：先问原生，不能把磁盘里的旧歌装回去。
                const native = await readNativeQueueState();
                report.push(native
                    ? `原生:${native.fromDisk ? '盘' : '活'} hasSong=${native.hasSong} n=${native.entries?.length ?? 0} idx=${native.index} pos=${Math.round((native.positionMs || 0) / 1000)}`
                    : '原生:null');
                const nativeStillPlaying = Boolean(
                    native
                    && !native.fromDisk
                    && native.hasSong
                    && native.nativeMedia?.songKey === native.songKey
                    && native.nativeMedia?.url,
                );
                if (nativeStillPlaying && askedSongKeyRef.current === null) {
                    /*
                     * 认领之前先把**盘上那份完整队列**摆好。
                     *
                     * 原生快照里的每首歌只带镜像字段（歌名、歌手、封面、平台 id）——
                     * 那是给通知栏和切歌用的。直接拿它当 `playQueue`，界面上那些歌就只剩
                     * 一个壳：专辑、音质偏好、歌词状态、来源扩展全没了，看着就像「歌单被
                     * 重置了一遍」。
                     *
                     * 内容用磁盘那份，顺序与当前曲用原生那份：adopt 已经负责了后者。
                     */
                    const cachedQueue = await getFromCache<SongResult[]>('last_queue');
                    const adopted = adoptNativePlaybackState(native!);
                    if (adopted) {
                        if (cachedQueue && cachedQueue.length > 0) {
                            /*
                             * 内容用磁盘那份（字段全），顺序用原生那份：打乱、拖动、删歌
                             * 都是原生先知道，磁盘那份可能还停在旧顺序。
                             */
                            const normalized = cachedQueue.map(normalizePlaybackSongSource);
                            const ordered = orderQueueLikeMirror(normalized, native!.entries).queue;
                            setPlayQueue(ordered);
                            makeSongCurrent(ordered.find(song => getPlaybackSongKey(song) === native!.songKey) ?? normalized[0]);
                        }
                        shouldAutoPlayRef.current = false;
                        reportStage = '认领原生';
                        return;
                    }
                }
                // 读会话的这一刻记下平台下线计数：读完之后逐一核对，登出过的平台的歌
                // 不再回填（上游 v0.7.26 的语义；dev 原版没有这道闸）。
                const providerDropsAtStart = providerDropsSoFar();
                const signedOut = (song: SongResult) => keepSongsOfProvidersStanding([song], providerDropsAtStart).length === 0;
                let lastSong = await getFromCache<SongResult>('last_song');
                let lastQueue = await getFromCache<SongResult[]>('last_queue');
                report.push(`库:${lastSong ? '有歌' : '无歌'} q=${lastQueue?.length ?? 0}`);
                /** 原生快照里那份「听到哪儿」，只在与当前曲对得上时才算数。 */
                let nativeResumeSec = 0;
                let nativeResumeDurationSec = 0;

                /*
                 * 本地那份可能只写进去一半：划掉后台时系统的回收不等 IndexedDB 提交。
                 * 原生那份是每次切歌、每十秒写盘的，缺什么就用它补什么。
                 */
                const nativeEntries = native?.fromDisk ? native.entries ?? [] : [];
                let queueFromNative = false;
                let songFromNative = false;
                if (nativeEntries.length > 0 && (!lastQueue?.length || !lastSong)) {
                    if (!lastQueue?.length) {
                        lastQueue = nativeEntries.map(songFromMirrorEntry);
                        queueFromNative = true;
                        report.push(`队列按原生补齐(${lastQueue.length})`);
                    }
                    if (!lastSong) {
                        const index = Math.min(Math.max(native!.index, 0), lastQueue.length - 1);
                        lastSong = lastQueue[index] || lastQueue[0];
                        songFromNative = true;
                        report.push(`当前曲按游标补(${index})`);
                    }
                }

                if (lastSong) lastSong = normalizePlaybackSongSource(lastSong);
                if (lastQueue) lastQueue = lastQueue.map(normalizePlaybackSongSource);

                /*
                 * 顺序以原生那份为准。
                 *
                 * 用户打乱队列、拖动、删歌，这些动作原生都会收到一份新的镜像队列并落盘；
                 * 而 WebView 这份 `last_queue` 只要有一次没接上，就还停在旧顺序上 ——
                 * 「队列还在、顺序不对」比「什么都没有」更难解释。
                 *
                 * 只借它的顺序，歌本身仍用本地这份完整对象：镜像条目只有歌名、歌手、封面。
                 * 两条队列对不上八成（换过队列但原生还没跟上）就整段不采用。
                 */
                if (!queueFromNative && nativeEntries.length > 0 && lastQueue?.length) {
                    const ordered = orderQueueLikeMirror(lastQueue, nativeEntries);
                    if (ordered.reordered) report.push('顺序按原生重排');
                    lastQueue = ordered.queue;
                }

                /*
                 * 当前曲以原生为准。
                 *
                 * `last_queue` 每次队列变更都整份重写，几乎不会滞后；`last_song` 却只在几条
                 * JS 侧的播放路径上写 —— 原生接管之后切歌是服务自己做的，JS 只是跟着改
                 * store，那份记录就停在「JS 最后一次主动播放的那首」。
                 *
                 * 于是恢复出来「队列顺序对、当前这首不对、秒数也就跟着对不上」：原生快照里
                 * 的 songKey 才是进程被收走那一刻真正在放的。
                 */
                if (!songFromNative && native?.fromDisk && native.hasSong && lastQueue?.length) {
                    const entry = native.entries?.[native.index];
                    const nativeKey = native.songKey || entry?.songKey || '';
                    const fromNative = (nativeKey
                        ? lastQueue.find(song => getPlaybackSongKey(song) === nativeKey)
                        : undefined)
                        /*
                         * key 对不上（换过平台 id、或者老快照）时按歌名认。队列是同一份，
                         * 同名的那一条就是它 —— 比留着一首错的歌强。
                         */
                        ?? (entry?.title
                            ? lastQueue.find(song => song.name.trim() === entry.title.trim())
                            : undefined);
                    if (fromNative) {
                        songFromNative = true;
                        if (!lastSong || getPlaybackSongKey(lastSong) !== getPlaybackSongKey(fromNative)) {
                            report.push(`当前曲按原生纠正(${fromNative.name})`);
                            lastSong = fromNative;
                        }
                    }
                }

                /*
                 * 位置：原生那份每十秒连同秒数一起落盘，进程被收走之后它是唯一还在的
                 * 「听到哪儿」。只认同一首，否则会把上一首的秒数安到这一首上。
                 */
                if (native?.fromDisk && native.hasSong && lastSong) {
                    const nativeKey = native.songKey || native.entries?.[native.index]?.songKey || '';
                    const sameSong = songFromNative || !nativeKey || nativeKey === getPlaybackSongKey(lastSong);
                    if (sameSong) {
                        nativeResumeSec = Math.max(0, (native.positionMs || 0) / 1000);
                        nativeResumeDurationSec = Math.max(0, (native.durationMs || 0) / 1000);
                        report.push(`原生位置:${Math.round(nativeResumeSec)}`);
                    }
                }

                if (isStagePlaybackSong(lastSong) || lastQueue?.some(song => isStagePlaybackSong(song))) {
                    await clearPersistedStagePlaybackCache();
                    reportStage = '舞台会话已清';
                    return;
                }

                if (!lastSong) {
                    reportStage = '无会话数据';
                    return;
                }

                // Leave unsupported sessions cached for a build that registers their provider.
                // 当前这首不可播（平台没注册 / 换了 provider）时，先从队列里挑一首能播的顶上：
                // 整段会话作废太过分，队列本来就在手里。
                if (!isRestoredSongPlayable(lastSong)) {
                    const fallback = lastQueue?.find(song => isRestoredSongPlayable(song));
                    if (!fallback) {
                        reportStage = '当前曲不可播';
                        return;
                    }
                    lastSong = fallback;
                }
                lastQueue = lastQueue?.filter(song => isRestoredSongPlayable(song)) ?? null;

                const containsLocalSnapshot = [lastSong, ...(lastQueue || [])].some(song => (
                    Boolean((song as any).isLocal)
                    || Boolean((song as any).localRef?.songId)
                    || Boolean((song as any).localData?.id)
                ));
                if (containsLocalSnapshot) {
                    const [localSongs, catalog] = await Promise.all([
                        getLocalSongs(),
                        getLocalLibraryCatalogSnapshot(),
                    ]);
                    const songsById = new Map(localSongs.map(song => [song.id, song]));
                    const rebuild = (cached: SongResult): SongResult | null => {
                        const songId = (cached as any).localRef?.songId || (cached as any).localData?.id;
                        if (!songId) return cached;
                        const localSong = songsById.get(songId);
                        if (!localSong) return null;
                        return buildLocalQueue([localSong], undefined, catalog)[0] || null;
                    };
                    lastSong = rebuild(lastSong);
                    lastQueue = (lastQueue || []).map(rebuild).filter((song): song is SongResult => Boolean(song));
                    if (!lastSong || signedOut(lastSong)) {
                        reportStage = '当前曲已登出';
                        return;
                    }
                    lastQueue = keepSongsOfProvidersStanding(lastQueue, providerDropsAtStart);
                    const lastSongKey = getPlaybackSongKey(lastSong);
                    if (!lastQueue.some(song => getPlaybackSongKey(song) === lastSongKey)) {
                        lastQueue.unshift(lastSong);
                    }
                    await persistLastPlaybackCache(lastSong, rewritten() ? usePlaybackStore.getState().playQueue : lastQueue);
                }

                if (signedOut(lastSong)) {
                    reportStage = '当前曲已登出';
                    return;
                }
                lastQueue = lastQueue && keepSongsOfProvidersStanding(lastQueue, providerDropsAtStart);

                // A song asked for while the remembered one was being read stands: the restore gives up.
                if (askedSongKeyRef.current !== null) {
                    reportStage = '被别的点歌打断';
                    return;
                }

                console.log('[Session] Restoring last song:', lastSong.name);

                /*
                 * 上次听到哪儿。
                 *
                 * 队列与当前曲一直有快照，位置没有 —— 所以每次重开都是从头一首、从 0:00，
                 * 用户听到一半退出，回来得自己拖回去，队列顺序也一并被重置。
                 *
                 * 只认同一首歌：库里换过 id、换过音源版本的话，这个秒数对别的歌没有意义。
                 * 读一条几十字节的 IndexedDB 记录是毫秒级，放在这里不会让恢复变慢。
                 */
                const savedPosition = await readPlaybackPositionForSong(lastSong);
                const probe = getPositionWriteProbe();
                report.push(`位置:${savedPosition ? Math.round(savedPosition.positionSec) : '无'}`);
                report.push(`上次写:${probe ? `${Math.round(probe.positionSec)}秒@${probe.name.slice(0, 8)}` : '无'}`);
                if (askedSongKeyRef.current !== null) {
                    reportStage = '读位置时被打断';
                    return;
                }
                /*
                 * 两个来源取更远的那个。
                 *
                 * WebView 那份十秒一存、更细；原生那份是心跳顺手落的盘，进程被杀的最后一刻
                 * 它反而更近。都是「同一首歌上次听到哪儿」，取大不会把用户往前拽。
                 */
                const resumeSec = Math.max(savedPosition?.positionSec ?? 0, nativeResumeSec);
                const resumeDurationSec = Math.max(savedPosition?.durationSec ?? 0, nativeResumeDurationSec);
                // 已经听到尾巴了：那一点不算「听到过」。从 0 重新来，否则一进来就切下一首。
                const nearEnd = resumeDurationSec > 0 && resumeSec > resumeDurationSec - 5;
                if (!nearEnd && resumeSec > 3) {
                    pendingResumeTimeRef.current = resumeSec;
                    // 这份位置可能是从原生快照捡回来的：立刻在 WebView 这边也落一条，
                    // 下次 WebView 自己就有数据，不必每次都从原生补。
                    if (!savedPosition) {
                        void savePlaybackPosition(lastSong, resumeSec, resumeDurationSec).catch(() => undefined);
                    }
                }

                if (lastSong.sourceRef?.kind === 'online' && lastSong.sourceRef.providerId) {
                    const currentActiveProviderId = useOnlineProviderAccountStore.getState().activeProviderId;
                    if (currentActiveProviderId !== lastSong.sourceRef.providerId) {
                        console.log(`[Session] Aligning active provider to restored song provider: ${lastSong.sourceRef.providerId}`);
                        useOnlineProviderAccountStore.getState().setActiveProviderId(lastSong.sourceRef.providerId);
                    }
                }
                makeSongCurrent(lastSong);
                const stillWanted = startRestore();
                const rememberedQueue = lastQueue && lastQueue.length > 0 ? lastQueue : [lastSong];
                if (rewritten()) {
                    // Saved again now that a song is current: the replacement's own save found none, so it kept nothing.
                    void persistLastPlaybackCache(lastSong, usePlaybackStore.getState().playQueue);
                    // The remembered queue is the listener's: the replacement's undo puts it back.
                    reportYieldedQueue({ queue: rememberedQueue, song: lastSong });
                } else {
                    setPlayQueue(rememberedQueue);
                    // 队列是从原生快照重建的：WebView 的库刚才没读到它，现在补写一份，
                    // 下次不必再绕原生。
                    if (queueFromNative) void persistLastPlaybackCache(lastSong, rememberedQueue);
                }

                // Read at restore time rather than subscribed: this effect runs once, and the
                // switch only ever has to answer for this one launch.
                const autoPlayOnLaunch = useAudioSettingsStore.getState().autoPlayOnLaunch;
                if (autoPlayOnLaunch) {
                    // Arm before the source lands. The bridge's autoplay effect fires on the commit
                    // that gives the deck its src, and it spends this flag there; setting it after
                    // would miss that run and leave the deck buffered in silence.
                    shouldAutoPlayRef.current = true;
                    // 「同时跳转至可视化页面」：等音源落地再切会先白一下首页，而这里要的就是
                    // 打开应用直接是那一页。两个开关一起读：下面的开关只在上面那个开着时才有页面可看。
                    if (useAudioSettingsStore.getState().autoJumpToVisualizerOnLaunch) {
                        jumpToPlayerOnLaunch?.();
                    }
                }

                let outcome: RestorePlaybackSourceOutcome = 'failed';
                try {
                    handedToSourceRestore = true;
                    outcome = await restorePlaybackSourceForSong(lastSong, {
                        audioQuality,
                        userId,
                        blobUrlRef,
                        currentOnlineAudioUrlFetchedAtRef,
                        setLyrics,
                        restoreCachedThemeForSong,
                        persistLastPlaybackCache,
                        queue: lastQueue || [lastSong],
                        stillWanted,
                        queueWritesAtStart: writesAtStart,
                    });
                } catch (error) {
                    console.warn('Failed to restore audio/lyrics for last session', error);
                }

                // A song was asked for meanwhile, another one or this same one: the intent to play
                // and what is fetched next are that play's.
                if (outcome === 'stale' || !stillWanted() || askedSongKeyRef.current !== getPlaybackSongKey(lastSong)) return;
                if (outcome === 'failed') {
                    // No source ever landed (the restore failed, or threw), so the intent was never
                    // spent. Left standing it would fire on whatever the listener plays next, which
                    // they did not ask for.
                    shouldAutoPlayRef.current = false;
                }

                // Restoring a session sets up the current song and stops, so until the listener
                // changes track nothing around it has been fetched: the next song's URL and lyrics
                // are cold, and neither track has been measured for automix. That makes the first
                // song change of every session the slowest one and the only one that blends blind.
                // Every other entry into playback prefetches; this one was simply never wired to.
                // Around the store's queue as it is now: the remembered one less what a mod's
                // replacement or a sign-out of a platform took out of it while the source was restored.
                // The mark is the one from the start of the restore: the drop happened before this line,
                // a fresh mark would see nothing and keep the signed-out songs.
                const queueForPrefetch = rewritten() ? usePlaybackStore.getState().playQueue : (lastQueue || [lastSong]);
                void prefetchNearbySongs(lastSong, keepSongsOfProvidersStanding(queueForPrefetch, providerDropsAtStart), audioQuality, userId);
                reportStage = `已恢复(${outcome})`;
            } catch (error) {
                console.error('Session restore failed', error);
                reportStage = '异常';
            } finally {
                // 没东西可恢复（没记住歌 / 已被别的点歌打断 / 本地文件没了 / Stage 会话）：
                // 上一个窗口留在 mpv 里的那首现在没人认领，放掉它。
                if (!handedToSourceRestore) releaseUnclaimedHifiTrack('nothing to restore');
                /*
                 * 一秒半之后再看一眼 store：恢复「做完了又被别人覆盖」和「压根没做」在日志里
                 * 长得一样，而在界面上不一样 —— 这一条能区分。
                 */
                const summary = `${reportStage}｜${report.join('｜')}`;
                /*
                 * globalThis 而不是 window：单测在 node 环境里直接调 restoreSession，
                 * 没有 window，这一条就会变成 unhandled rejection，把跑得好好的用例拖下水。
                 */
                globalThis.setTimeout(() => {
                    const state = usePlaybackStore.getState();
                    /*
                     * 还没落地就再跑一遍。
                     *
                     * 冷启动这一拍最容易撞上的就是「库还没就绪 / 平台刚注册一半」，
                     * 一次 async 读回来的东西不全；隔一秒半环境就位了，同一段逻辑能成。
                     */
                    if (!state.currentSong && !retriedOnce) {
                        retriedOnce = true;
                        console.info('[Session] 恢复没落地，重试一次');
                        void restoreSession();
                        return;
                    }
                    const summaryText = `[会话] ${summary}｜1.5s后:${state.currentSong ? state.currentSong.name : '空'}/${state.playQueue.length}首`;
                    if (state.currentSong) {
                        // 恢复正常只留一行日志：这条链路每次启动都跑，屏幕上不该有痕迹。
                        console.info(summaryText);
                        return;
                    }
                    console.warn(summaryText);
                    setStatusMsg({
                        type: 'info',
                        text: '[会话] 没能接上上次的播放，已按默认状态启动',
                        nonce: Date.now(),
                    });
                }, 1500);
            }
        };

        void restoreSession();
    }, [canRestoreSession]);
}
