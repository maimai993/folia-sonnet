import type { SongResult } from '../../../types';
import type { MediaId, OmniProviderId, OnlineMusicProvider, ProviderLikedSongIds } from '../../../types/onlineMusic';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { createLikePresses } from '../../../utils/likePresses';
import type { LikePresses } from '../../../utils/likePresses';
import { createAccountReads } from '../account/accountRead';
import { createLikedChecks } from '../account/likedChecks';
import { keptAfterRead } from '../account/keptAfterRead';
import type { AccountRead } from '../account/keptAfterRead';
import { createAccountMoments } from '../account/readMoments';
import { getOnlineMusicProvider } from '../providerRegistry';
import { saveProviderAccountSnapshot } from '../providerAccountCache';
import { unsupported } from './providerCalls';
import { omniService } from './serviceAccess';

// src/services/onlineMusic/omni/accountLikes.ts
// The liked songs of an account: the hearts pressed in Folia, what the platform answers, and the one
// rule that settles them (account/keptAfterRead.ts).

/** 原生补写的一条红心：WebView 冻结期间通知栏 / 锁屏那颗心已经写到服务器上了。 */
export interface NativeLikeOverrideInput {
    providerId: string;
    serverSongId: string;
    liked: boolean;
}

/**
 * 把原生补写的红心对齐进账号缓存（likedSongIds）。
 *
 * 原生扣下通知栏控制权时，那颗心由原生直接写服务器；Web 这边不知道，缓存里还是旧状态，
 * 打开 App 时两边会打架。这里只改缓存、不再写一遍平台 —— 平台那边已经是目标状态了，
 * 再写一遍是浪费；之后的账号读取也会从服务器带回同一个状态，两边天然收敛。
 * 账号还没读进来（没 user）时跳过：那时也没有旧状态可翻，等读取即可。
 */
export const applyNativeLikeOverrides = (overrides: NativeLikeOverrideInput[]): void => {
    const accounts = useOnlineProviderAccountStore.getState().accounts;
    const updates = new Map<OmniProviderId, MediaId[]>();
    for (const item of overrides) {
        const providerId = item.providerId as OmniProviderId;
        const account = accounts[providerId];
        if (!account?.user || !item.serverSongId) continue;
        const current = updates.get(providerId) ?? [...(account.likedSongIds || [])];
        const filtered = current.filter(id => String(id) !== String(item.serverSongId));
        updates.set(providerId, item.liked ? [...filtered, item.serverSongId as MediaId] : filtered);
    }
    updates.forEach((likedSongIds, providerId) => {
        useOnlineProviderAccountStore.getState().updateAccount(providerId, { likedSongIds });
        void persistProviderLikedSongIds(providerId);
    });
};

// 点赞状态改完要落盘：只更内存的话，重启后靠快照 hydration 的那一帧会恢复旧心形，
// 后台刷新再失败就一直是旧的。
export const persistProviderLikedSongIds = async (providerId: OmniProviderId): Promise<void> => {
    const account = useOnlineProviderAccountStore.getState().accounts[providerId];
    if (!account?.user) return;
    try {
        await saveProviderAccountSnapshot(providerId, {
            user: account.user,
            collections: account.collections || [],
            likedSongIds: account.likedSongIds || [],
        });
    } catch (error) {
        // 落盘失败不能把一次成功的 mutation 变成失败，下一次刷新会补上。
        console.warn('[Omni] Failed to persist liked songs after a like mutation', { providerId }, error);
    }
};

// The presses on hearts (likePresses.ts), one provider's songs apart from another's. What is
// wanted for a song whose request is not settled goes into the account store (`wantedLikes`),
// where `isSongLiked` reads it and the screen follows it.
const likePressesByProvider = new Map<OmniProviderId, LikePresses>();
export const likePressesOf = (providerId: OmniProviderId): LikePresses => {
    let presses = likePressesByProvider.get(providerId);
    if (!presses) {
        presses = createLikePresses({
            name: providerId,
            onChange: wantedLikes => useOnlineProviderAccountStore.getState().updateAccount(providerId, { wantedLikes }),
        });
        likePressesByProvider.set(providerId, presses);
    }
    return presses;
};

// One like request to the song's provider. Taken, the account's liked ids follow it; refused,
// they stay as they are and the error goes up. `signal`: see `LikeSend` in likePresses.ts.
export const sendSongLike = async (
    provider: OnlineMusicProvider,
    song: SongResult,
    source: { providerId: OmniProviderId; mediaId: MediaId },
    liked: boolean,
    signal: AbortSignal,
): Promise<void> => {
    if (!provider.mutations?.likeSong) return unsupported(provider.id, 'likes');

    const songKey = String(source.mediaId);
    const account = useOnlineProviderAccountStore.getState().accounts[source.providerId];
    // Whether the account is still the one the request is made for: an answer that comes after
    // it was cleared or changed writes nothing into the account that is there then. A request
    // sent before the account was named (app start: the session is there, its user is read a
    // moment later) belongs to whoever is named when it is answered.
    const sentAs = account?.user?.id;
    const isSameAccount = (): boolean => (
        sentAs === undefined || sentAs === null
        || String(useOnlineProviderAccountStore.getState().accounts[source.providerId]?.user?.id) === String(sentAs)
    );

    // 失败时点赞状态保持原样，错误往上抛给调用方。
    await provider.mutations.likeSong(song, liked);

    // An answer to a request that was given up (the heart was put back and the run ended as
    // failed) writes no like: the next whole read of the liked songs says what the provider
    // holds.
    if (signal.aborted) {
        console.log(`[Like] ${source.providerId}:${songKey} answered after the request was given up; nothing is written`);
        return;
    }
    // An answer for an account that was signed out or changed meanwhile writes nothing into the
    // account that is there now. The run still ends as taken: the provider did take it.
    if (!isSameAccount()) {
        console.log(`[Like] ${source.providerId}:${songKey} answered after its account left; nothing is written`);
        return;
    }

    // 成功之后写 likedSongIds：直接调 likeSong 的入口（例如"我喜欢"网格里删歌）也必须让账号缓存
    // 跟着走，否则和 toggleSongLike 两个入口语义不同。
    //
    // @note 网易云不再是例外（2026-10-09）：它的点赞集合原来由 useNeteaseLibrary 的本地 state 当家，
    // 再单向镜像到这个 store，所以从 GridView 直接调用这里时网易云的播放器心形不会跟着变。现在那份
    // state 已经挪进这个 store，useNeteaseLibrary 不再交出点赞的集合，播放器的心形直接读这个 store
    // （usePlayerPanelModel），这里写完心形就跟着变。
    const latest = useOnlineProviderAccountStore.getState().accounts[source.providerId];
    const likedSongIds = (latest?.likedSongIds || []).filter(id => String(id) !== songKey);
    useOnlineProviderAccountStore.getState().updateAccount(source.providerId, {
        likedSongIds: liked ? [...likedSongIds, source.mediaId] : likedSongIds,
    });
    await persistProviderLikedSongIds(source.providerId);
};

/** A read of an account's liked songs under way: the account's read, a moment's, or the liked list's own (`beginLikedListRead`). */
export interface LikedListRead extends AccountRead {
    providerId: OmniProviderId;
}

// How many reads of each provider's liked songs have begun, and the number of the newest whole
// one that was applied: an answer that comes after the whole answer of a read begun later is
// dropped. A read that was not whole only added, so it holds no other read back.
const likedReadsBegun = new Map<OmniProviderId, number>();
const likedReadsApplied = new Map<OmniProviderId, number>();

export const beginLikedRead = (providerId: OmniProviderId, userId: MediaId): LikedListRead => {
    const order = (likedReadsBegun.get(providerId) ?? 0) + 1;
    likedReadsBegun.set(providerId, order);
    return { providerId, userId, beganAt: Date.now(), order };
};

// The end of a read of an account's liked songs: what was read meets what the listener pressed by
// the one rule (account/keptAfterRead.ts), and the account store is written where that changes
// what is held. Says whether it was applied, whether the liked ids changed (saving the snapshot is
// the caller's), and whether the account now holds what the answer held: it was applied and no
// song kept what Folia held because it was pressed. `notLiked`: the answer is a check of some
// songs (account/likedChecks.ts), and these it found not liked.
const applyLikedRead = (
    read: LikedListRead,
    answer: ProviderLikedSongIds,
    notLiked?: MediaId[],
): { applied: boolean; changed: boolean; alike: boolean } => {
    const account = useOnlineProviderAccountStore.getState().accounts[read.providerId];
    const held = account?.likedSongIds || [];
    const what = notLiked
        ? `hearts of ${answer.ids.length + notLiked.length} songs in play checked (${answer.ids.length} liked)`
        : `liked songs read (${answer.whole ? 'whole' : 'not whole'}, ${answer.ids.length} ids)`;
    const kept = keptAfterRead({
        read,
        answer,
        notKept: notLiked,
        held,
        signedInUserId: account?.user?.id,
        newestApplied: likedReadsApplied.get(read.providerId) ?? 0,
        touchedSince: likePressesOf(read.providerId).touchedSince,
    });
    if ('refused' in kept) {
        console.log(`[Like] ${read.providerId}: ${what} not applied: ${kept.refused}; the liked songs stay as they were`);
        return { applied: false, changed: false, alike: false };
    }
    if (answer.whole) likedReadsApplied.set(read.providerId, read.order);
    console.log(`[Like] ${read.providerId}: ${what} applied: ${kept.added} added, ${kept.removed} removed, ${kept.pressed.size} kept because pressed`);

    const changed = kept.added > 0 || kept.removed > 0;
    const alike = kept.pressed.size === 0;
    if (changed) useOnlineProviderAccountStore.getState().updateAccount(read.providerId, { likedSongIds: kept.ids });
    return { applied: true, changed, alike };
};

// Where a platform's liked list was not read to the end, the hearts of the songs in play are
// asked of it (account/likedChecks.ts), and settled by the one rule above.
export const likedChecks = createLikedChecks({
    signedIn: providerId => useOnlineProviderAccountStore.getState().accounts[providerId]?.user?.id ?? null,
    asker: providerId => {
        const library = getOnlineMusicProvider(providerId)?.library;
        return library?.areSongsLiked ? ids => library.areSongsLiked!(ids) : null;
    },
    beginLikedRead,
    applyLikedCheck: (read, liked, notLiked) => {
        if (applyLikedRead(read, { ids: liked, whole: false }, notLiked).changed) void persistProviderLikedSongIds(read.providerId);
    },
});

// A read of the liked ids, by the adapter (`getLikedSongIds`) or of the liked list from its first
// page (`endLikedListRead`), settled by the one rule; whether it was whole decides whether the
// songs in play are checked (account/likedChecks.ts).
export const applyLikedIdsRead = (read: LikedListRead, answer: ProviderLikedSongIds): { changed: boolean; alike: boolean } => {
    const ended = applyLikedRead(read, answer);
    if (ended.applied) likedChecks.likedRead(read.providerId, read.userId, answer.whole);
    return ended;
};

// Reads an account's liked song ids whole from its provider. What was read meets what the
// listener pressed meanwhile, and a newer account, by the one rule, and the snapshot is saved
// where the liked ids changed. Rejects where the read failed: no liked id is changed then.
// Answers whether the account now holds what the answer held (see `applyLikedRead`).
// `countedEmpty`: the platform's count of the list, asked just before, was 0 (account/readMoments.ts).
export const readLikedSongIds = async (providerId: OmniProviderId, userId: MediaId, countedEmpty = false): Promise<boolean> => {
    const read = { ...beginLikedRead(providerId, userId), countedEmpty };
    const answer = await omniService().getProviderLikedSongIds(providerId, userId);
    const { changed, alike } = applyLikedIdsRead(read, answer);
    if (changed) await persistProviderLikedSongIds(providerId);
    return alike;
};

// The reads of an account from its platform (account/accountRead.ts): who is signed in, their
// playlists, their liked ids. The liked ids it reads are settled by the one rule above.
export const accountReads = createAccountReads({
    beginLikedRead,
    applyLikedRead: applyLikedIdsRead,
    forgetLikePresses: providerId => likePressesByProvider.get(providerId)?.forget(),
    // Only spans of time are measured: a clock that is set back must not hold the reads off.
    now: () => performance.now(),
});

// The moments at which an account's liked songs may have been changed in its platform's own app
// (account/readMoments.ts decides what is asked and read then). The seam to the platforms is the
// two entries below, the same for every platform: the adapter's own count of its liked list, and
// the read of the liked ids. A moment that falls into a read of the account under way joins its
// liked part and reads no second time.
export const accountMoments = createAccountMoments({
    account: providerId => {
        const account = useOnlineProviderAccountStore.getState().accounts[providerId];
        const userId = account?.user?.id;
        if (!account || userId === undefined || userId === null) return null;
        return { userId, likedHeld: (account.likedSongIds || []).length };
    },
    likedCount: (providerId, userId) => getOnlineMusicProvider(providerId)?.library?.getLikedSongCount?.(userId),
    readLikedWhole: (providerId, userId, countedEmpty) => accountReads.likedOfReadUnderWay(providerId) ?? readLikedSongIds(providerId, userId, countedEmpty),
    // Only spans of time are measured: a clock that is set back must not hold the checks off.
    now: () => performance.now(),
});
