import type { UnifiedSong } from '../../../src/types';
import {
    OnlineProviderError,
    type MediaId,
    type OnlineMusicProvider,
    type ProviderCollection,
    type ProviderPage,
} from '../../../src/types/onlineMusic';
import { registerOnlineMusicProvider } from '../../../src/services/onlineMusic/providerRegistry';
import {
    hasAlias,
    hasGuestArtist,
    hasSecondAlbum,
    hasTranslatedName,
    isProbeUnavailable,
    ONLINE_FIXTURES,
    onlineSongId,
    onlineSongName,
    PROBE_ALBUM,
    PROBE_ALIAS,
    PROBE_PROVIDER_A,
    PROBE_PROVIDER_B,
    PROBE_SECOND_ALBUM,
    PROBE_TRANSLATED_NAME,
    PROBE_TRACKS_UPDATED_AT,
} from './fixtureRules';
import { recordProbeRequest } from './probeLog';
import { createProbeGate, type ProbeGate } from './probeGates';

// dev/probes/libraryBehavior/fakeProviders.ts
// 两个内存里的假在线 provider（probe-a / probe-b）。走真实的 provider registry 和 omni，
// 只把网络换成可控的数据、延迟和故障注入，探针因此能覆盖「omni → 分页 → 缓存 → 界面」整条链。

export type ProbeFault = {
    op: string;
    target: string;
    offset?: number;
    remaining: number;
};

type CollectionData = {
    providerId: string;
    type: string;
    id: string;
    name: string;
    songs: UnifiedSong[];
    error?: 'not-public';
    isOwned?: boolean;
};

const collections = new Map<string, CollectionData>();
const subscriptions = new Map<string, boolean>();
const faults: ProbeFault[] = [];
/** target → 每次请求的延迟；`first` 只作用于 offset 0。 */
const latencies = new Map<string, { first?: number; rest?: number }>();
let dislikeCounter = 0;
/**
 * target → 按住的后台分页（offset > 0）。按住的是应答而不是请求：页面在请求那一刻就按当时的上游数据
 * 生成，放行时才送达，模拟「请求发出之后上游又变了」的晚到页。
 */
const pagingGates = new Map<string, ProbeGate>();

const targetKey = (providerId: string, type: string, id: MediaId) => `${providerId}:${type}:${String(id)}`;

/** 在线 fixture 在请求账里的 target。 */
export const onlineFixtureTarget = (fixtureId: keyof typeof ONLINE_FIXTURES): string => {
    const rule = ONLINE_FIXTURES[fixtureId];
    return targetKey(rule.providerId, rule.type, rule.collectionId);
};

export const holdProbePaging = (target: string): void => {
    const gate = pagingGates.get(target) ?? createProbeGate();
    gate.hold();
    pagingGates.set(target, gate);
};

export const releaseProbePaging = (target: string): void => {
    pagingGates.get(target)?.release();
    pagingGates.delete(target);
};

/** 生成一首在线歌：字段形状与 omni 归一化后的 UnifiedSong 一致，专辑带 catalogRef 以便嵌套导航。 */
export const makeOnlineSong = (
    providerId: string,
    prefix: string,
    index: number,
    album?: { id: string; name: string },
): UnifiedSong => {
    const id = onlineSongId(prefix, index);
    const resolvedAlbum = album ?? (hasSecondAlbum(index) ? PROBE_SECOND_ALBUM : PROBE_ALBUM);
    return {
        id,
        name: onlineSongName(index),
        ...(hasAlias(index) ? { aliases: [PROBE_ALIAS] } : {}),
        ...(hasTranslatedName(index) ? { translatedNames: [PROBE_TRANSLATED_NAME] } : {}),
        artists: [
            { id: 'ar-1', name: 'Probe Artist' },
            ...(hasGuestArtist(index) ? [{ id: 'ar-2', name: 'Guest Singer' }] : []),
        ],
        album: {
            id: resolvedAlbum.id,
            name: resolvedAlbum.name,
            catalogRef: { providerId, kind: 'album', id: resolvedAlbum.id },
        },
        durationMs: 180000 + index * 1000,
        sourceRef: { kind: 'online', providerId, mediaId: id },
    };
};

/** 恢复全部在线 fixture、订阅状态与故障注入的初始值。 */
export const resetFakeProviders = (): void => {
    collections.clear();
    subscriptions.clear();
    faults.length = 0;
    latencies.clear();
    pagingGates.forEach(gate => gate.release());
    pagingGates.clear();
    dislikeCounter = 0;

    Object.values(ONLINE_FIXTURES).forEach(rule => {
        collections.set(targetKey(rule.providerId, rule.type, rule.collectionId), {
            providerId: rule.providerId,
            type: rule.type,
            id: rule.collectionId,
            name: rule.name,
            songs: rule.rawIndexes.map(index => makeOnlineSong(rule.providerId, rule.prefix, index)),
            ...(rule.collectionId === 'private' ? { error: 'not-public' as const } : {}),
            ...(rule.isOwned ? { isOwned: true } : {}),
        });
    });
    collections.set(targetKey(PROBE_PROVIDER_A, 'album', PROBE_ALBUM.id), {
        providerId: PROBE_PROVIDER_A,
        type: 'album',
        id: PROBE_ALBUM.id,
        name: PROBE_ALBUM.name,
        songs: PROBE_ALBUM.rawIndexes.map(index => makeOnlineSong(PROBE_PROVIDER_A, PROBE_ALBUM.prefix, index, PROBE_ALBUM)),
    });

    faults.push(
        { op: 'playlistTracks', target: targetKey(PROBE_PROVIDER_A, 'playlist', 'flaky'), offset: 150, remaining: 1 },
        // 1 次首发 + 3 次退避重试全部失败，才会进入「中断」。
        { op: 'playlistTracks', target: targetKey(PROBE_PROVIDER_A, 'playlist', 'broken'), offset: 150, remaining: 4 },
    );
    latencies.set(targetKey(PROBE_PROVIDER_A, 'playlist', 'slow'), { first: 1200, rest: 300 });
};

export const addProbeFault = (fault: ProbeFault): void => {
    faults.push(fault);
};

export const setProbeLatency = (target: string, latency: { first?: number; rest?: number }): void => {
    latencies.set(target, latency);
};

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// 统一记账、延迟与故障：每个假接口都从这里过。
const run = async <T>(
    providerId: string,
    op: string,
    target: string,
    details: { offset?: number; limit?: number; ids?: string[] },
    produce: () => T,
): Promise<T> => {
    const latency = latencies.get(target);
    const delay = details.offset === 0 || details.offset === undefined
        ? latency?.first ?? latency?.rest
        : latency?.rest;
    if (delay) await wait(delay);

    const fault = faults.find(candidate => (
        candidate.remaining > 0
        && candidate.op === op
        && candidate.target === target
        && (candidate.offset === undefined || candidate.offset === details.offset)
    ));
    if (fault) {
        fault.remaining -= 1;
        recordProbeRequest({ provider: providerId, op, target, ...details, outcome: 'error' });
        throw new OnlineProviderError('network', `probe fault: ${op} ${target}`, providerId);
    }

    const data = collections.get(target);
    if (data?.error === 'not-public') {
        recordProbeRequest({ provider: providerId, op, target, ...details, outcome: 'error' });
        throw new OnlineProviderError('not-public', 'probe: playlist is not public', providerId);
    }

    recordProbeRequest({ provider: providerId, op, target, ...details, outcome: 'ok' });
    const result = produce();
    const pagingGate = pagingGates.get(target);
    if (pagingGate && op === 'playlistTracks' && (details.offset ?? 0) > 0) await pagingGate.wait();
    return result;
};

const pageOf = (songs: UnifiedSong[], limit: number, offset: number): ProviderPage<UnifiedSong> => {
    const items = songs.slice(offset, offset + limit);
    return {
        items,
        total: songs.length,
        hasMore: offset + items.length < songs.length,
        nextOffset: offset + items.length,
    };
};

const describe = (data: CollectionData | undefined, fallback?: ProviderCollection): ProviderCollection | null => {
    if (!data) return fallback ?? null;
    return {
        ...(fallback ?? {}),
        providerId: data.providerId,
        id: data.id,
        name: data.name,
        type: data.type,
        trackCount: data.songs.length,
        tracksUpdatedAt: PROBE_TRACKS_UPDATED_AT,
        updatedAt: PROBE_TRACKS_UPDATED_AT,
        ...(data.isOwned ? { isOwned: true } : {}),
    };
};

const createFakeProvider = (providerId: string): OnlineMusicProvider => ({
    id: providerId,
    displayName: `Probe ${providerId}`,
    shortName: providerId,
    getAvailability: () => ({ configured: true }),
    capabilities: {
        search: false,
        playback: true,
        lyrics: false,
        auth: false,
        userLibrary: false,
        playlists: true,
        albums: true,
        artists: false,
        recommendations: true,
        mutations: true,
        wordByWordLyrics: false,
        historyRecommendations: true,
        playlistSubscription: true,
        playlistTrackMutations: true,
        likes: true,
    },
    normalizeSong: raw => raw as UnifiedSong,
    playback: {
        getSongDetail: async () => null,
        getAudioSource: async () => null,
        getAvailability: song => {
            const index = Number(String(song.id).split('-').pop());
            return Number.isFinite(index) && isProbeUnavailable(index)
                ? { state: 'unavailable', label: 'N/A' }
                : { state: 'playable' };
        },
    },
    catalog: {
        getPlaylistTracks: (id, limit, offset) => {
            const target = targetKey(providerId, 'playlist', id);
            return run(providerId, 'playlistTracks', target, { offset, limit }, () => (
                pageOf(collections.get(target)?.songs ?? [], limit, offset)
            ));
        },
        getPlaylistDetail: (id, collection) => {
            const target = targetKey(providerId, 'playlist', id);
            return run(providerId, 'playlistDetail', target, {}, () => describe(collections.get(target), collection));
        },
        getAlbumTracks: (id, limit = 1000, offset = 0) => {
            const target = targetKey(providerId, 'album', id);
            return run(providerId, 'albumTracks', target, { offset, limit }, () => (
                pageOf(collections.get(target)?.songs ?? [], limit, offset)
            ));
        },
        getAlbumDetail: (id, collection) => {
            const target = targetKey(providerId, 'album', id);
            return run(providerId, 'albumDetail', target, {}, () => describe(collections.get(target), collection));
        },
        getSubscriptionStatus: (type, id) => {
            const target = targetKey(providerId, type, id);
            return run(providerId, 'subscriptionStatus', target, {}, () => subscriptions.get(target) ?? false);
        },
    },
    recommendations: {
        getDailySongs: () => {
            const target = targetKey(providerId, 'daily_recommendations', 'daily_recommendations');
            return run(providerId, 'dailySongs', target, {}, () => [...(collections.get(target)?.songs ?? [])]);
        },
        getHistoryDates: () => run(providerId, 'historyDates', `${providerId}:history`, {}, () => ['2026-09-30']),
        getHistorySongs: () => run(providerId, 'historySongs', `${providerId}:history`, {}, () => (
            [0, 1, 2].map(index => makeOnlineSong(providerId, 'history', index))
        )),
        dislikeSong: id => run(providerId, 'dislikeSong', `${providerId}:daily`, { ids: [String(id)] }, () => {
            const replacement = makeOnlineSong(providerId, 'daily-r', dislikeCounter);
            dislikeCounter += 1;
            return { replacement };
        }),
    },
    mutations: {
        likeSong: async (song, liked) => {
            const id = typeof song === 'object' ? String(song.id) : String(song);
            await run(providerId, liked ? 'like' : 'unlike', `${providerId}:likes`, { ids: [id] }, () => undefined);
        },
        updatePlaylistTracks: async (operation, playlist, tracks) => {
            const playlistId = typeof playlist === 'object' ? playlist.id : playlist;
            const target = targetKey(providerId, 'playlist', playlistId);
            const ids = tracks.map(track => (typeof track === 'object' ? String(track.id) : String(track)));
            await run(providerId, `updatePlaylistTracks:${operation}`, target, { ids }, () => {
                const data = collections.get(target);
                if (data && operation === 'del') {
                    const removing = new Set(ids);
                    data.songs = data.songs.filter(song => !removing.has(String(song.id)));
                }
            });
        },
        subscribePlaylist: async (playlist, subscribed) => {
            const playlistId = typeof playlist === 'object' ? playlist.id : playlist;
            const target = targetKey(providerId, 'playlist', playlistId);
            await run(providerId, subscribed ? 'subscribePlaylist' : 'unsubscribePlaylist', target, {}, () => {
                subscriptions.set(target, subscribed);
            });
        },
        subscribeAlbum: async (id, subscribed) => {
            const target = targetKey(providerId, 'album', id);
            await run(providerId, subscribed ? 'subscribeAlbum' : 'unsubscribeAlbum', target, {}, () => {
                subscriptions.set(target, subscribed);
            });
        },
    },
});

/** 注册两个假 provider。可重复调用：StrictMode 下挂载 effect 会先拆一次再装回来。 */
export const registerFakeProviders = (): void => {
    registerOnlineMusicProvider(createFakeProvider(PROBE_PROVIDER_A));
    registerOnlineMusicProvider(createFakeProvider(PROBE_PROVIDER_B));
};

/** 把 fixture 规则转成首页「歌单列表」里的那条 ProviderCollection。 */
export const describeOnlineFixture = (fixtureId: keyof typeof ONLINE_FIXTURES): ProviderCollection => {
    const rule = ONLINE_FIXTURES[fixtureId];
    const data = collections.get(targetKey(rule.providerId, rule.type, rule.collectionId));
    return {
        providerId: rule.providerId,
        id: rule.collectionId,
        name: rule.name,
        type: rule.type,
        trackCount: data?.songs.length ?? rule.rawIndexes.length,
        // 每日推荐在真实首页上不带更新时间：它的缓存永远不命中，探针保持一致。
        ...(rule.type === 'playlist'
            ? { tracksUpdatedAt: PROBE_TRACKS_UPDATED_AT, updatedAt: PROBE_TRACKS_UPDATED_AT }
            : {}),
        ...(rule.isOwned ? { isOwned: true } : {}),
        creator: { id: 'probe-someone', nickname: 'Probe Curator' },
    };
};
