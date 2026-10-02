// dev/probes/libraryBehavior/fixtureRules.ts
// 行为探针的数据规则。刻意不 import 任何东西：探针拿它生成 fixture，component 用例拿它算期望值，
// 两边用的是同一条规则，而不是各自抄一份数字。

export const PROBE_PROVIDER_A = 'probe-a';
export const PROBE_PROVIDER_B = 'probe-b';
export const PROBE_WORDS = ['Amber', 'Birch', 'Cedar', 'Dune', 'Ember'] as const;
export const PROBE_TRACKS_UPDATED_AT = 1710000000000;

export const range = (count: number, start = 0): number[] => (
    Array.from({ length: count }, (_, index) => start + index)
);

export const onlineSongName = (index: number): string => `Track ${index} ${PROBE_WORDS[index % PROBE_WORDS.length]}`;
export const isProbeUnavailable = (index: number): boolean => index % 50 === 25;
export const hasGuestArtist = (index: number): boolean => index % 7 === 0;
export const hasSecondAlbum = (index: number): boolean => index % 10 === 0;
export const hasAlias = (index: number): boolean => index % 9 === 0;
export const hasTranslatedName = (index: number): boolean => index % 11 === 0;

export const PROBE_ALIAS = 'Alias Kite';
export const PROBE_TRANSLATED_NAME = '译名';

/** 歌单里重复条目的位置：key 是上游原始位置，value 是那里实际放的歌。 */
export const DUPE_POSITIONS: Readonly<Record<number, number>> = { 20: 5, 40: 6, 160: 10, 200: 170 };

export type OnlineFixtureId =
    | 'online-big'
    | 'online-dupes'
    | 'online-flaky'
    | 'online-broken'
    | 'online-slow'
    | 'online-private'
    | 'online-empty'
    | 'online-owned'
    | 'online-public'
    | 'online-daily'
    | 'collide-a'
    | 'collide-b';

export type LocalFixtureId = 'local-all' | 'local-folder' | 'local-playlist' | 'local-album';
export type NavidromeFixtureId = 'navi-album' | 'navi-playlist';
export type ProbeFixtureId = OnlineFixtureId | LocalFixtureId | NavidromeFixtureId;

export type OnlineFixtureRule = {
    providerId: string;
    collectionId: string;
    type: 'playlist' | 'daily_recommendations';
    name: string;
    /** 歌曲 id 前缀；歌曲 id = `${prefix}-${index}`。 */
    prefix: string;
    /** 上游原始顺序（含重复）。 */
    rawIndexes: number[];
    isOwned?: boolean;
};

export const ONLINE_FIXTURES: Readonly<Record<OnlineFixtureId, OnlineFixtureRule>> = {
    'online-big': { providerId: PROBE_PROVIDER_A, collectionId: 'big', type: 'playlist', name: 'Big Playlist', prefix: 'big', rawIndexes: range(350) },
    'online-dupes': {
        providerId: PROBE_PROVIDER_A,
        collectionId: 'dupes',
        type: 'playlist',
        name: 'Duplicate Entries',
        prefix: 'dupes',
        rawIndexes: range(220).map(position => DUPE_POSITIONS[position] ?? position),
    },
    'online-flaky': { providerId: PROBE_PROVIDER_A, collectionId: 'flaky', type: 'playlist', name: 'Flaky Paging', prefix: 'flaky', rawIndexes: range(400) },
    'online-broken': { providerId: PROBE_PROVIDER_A, collectionId: 'broken', type: 'playlist', name: 'Broken Paging', prefix: 'broken', rawIndexes: range(400) },
    'online-slow': { providerId: PROBE_PROVIDER_A, collectionId: 'slow', type: 'playlist', name: 'Slow First Page', prefix: 'slow', rawIndexes: range(3000) },
    'online-private': { providerId: PROBE_PROVIDER_A, collectionId: 'private', type: 'playlist', name: 'Private Playlist', prefix: 'private', rawIndexes: range(5) },
    'online-empty': { providerId: PROBE_PROVIDER_A, collectionId: 'empty', type: 'playlist', name: 'Empty Playlist', prefix: 'empty', rawIndexes: [] },
    'online-owned': { providerId: PROBE_PROVIDER_A, collectionId: 'owned', type: 'playlist', name: 'Owned Playlist', prefix: 'owned', rawIndexes: range(12), isOwned: true },
    'online-public': { providerId: PROBE_PROVIDER_A, collectionId: 'public', type: 'playlist', name: 'Public Playlist', prefix: 'public', rawIndexes: range(30) },
    'online-daily': { providerId: PROBE_PROVIDER_A, collectionId: 'daily_recommendations', type: 'daily_recommendations', name: 'Daily Picks', prefix: 'daily', rawIndexes: range(10) },
    'collide-a': { providerId: PROBE_PROVIDER_A, collectionId: 'same', type: 'playlist', name: 'Same Id (A)', prefix: 'ca', rawIndexes: range(5) },
    'collide-b': { providerId: PROBE_PROVIDER_B, collectionId: 'same', type: 'playlist', name: 'Same Id (B)', prefix: 'cb', rawIndexes: range(5) },
};

/** 曲目卡片上「专辑」链接指向的在线专辑。 */
export const PROBE_ALBUM = { id: 'al-1', name: 'Probe Album', prefix: 'alb', rawIndexes: range(10) } as const;
export const PROBE_SECOND_ALBUM = { id: 'al-2', name: 'Second Album' } as const;
export const PROBE_FIRST_PAGE = 150;
export const PROBE_BACKGROUND_PAGE = 1000;

export const onlineSongId = (prefix: string, index: number): string => `${prefix}-${index}`;
export const onlinePlaybackKey = (providerId: string, songId: string): string => `online:${providerId}:${songId}`;

/** 与 GridView 筛选实际生效的那几项一致：歌名、别名、译名、歌手（两种拼法）、专辑名。 */
export const onlineSearchText = (index: number): string => {
    const artists = ['Probe Artist', ...(hasGuestArtist(index) ? ['Guest Singer'] : [])];
    const searchText = [
        onlineSongName(index),
        hasAlias(index) ? PROBE_ALIAS : undefined,
        hasTranslatedName(index) ? PROBE_TRANSLATED_NAME : undefined,
    ].filter(Boolean).join(' ');
    return [
        searchText,
        artists.join(', '),
        hasSecondAlbum(index) ? PROBE_SECOND_ALBUM.name : PROBE_ALBUM.name,
        artists.join(' '),
    ].join(' ').toLowerCase();
};

/**
 * 当前代码加载完一个在线集合后的曲目顺序：首页原样保留（页内重复不去重），后续页按
 * playback key 去重追加。这是现状语义的记录，不是「应该如此」。
 */
export const expectedLoadedIndexes = (rawIndexes: number[], firstPage = PROBE_FIRST_PAGE): number[] => {
    const first = rawIndexes.slice(0, firstPage);
    const seen = new Set(first);
    const result = [...first];
    rawIndexes.slice(firstPage).forEach(index => {
        if (seen.has(index)) return;
        seen.add(index);
        result.push(index);
    });
    return result;
};

/** 期望的可播放顺序（筛选可选）。 */
export const expectedPlayableIndexes = (loadedIndexes: number[], query = ''): number[] => {
    const needle = query.trim().toLowerCase();
    return loadedIndexes.filter(index => (
        !isProbeUnavailable(index)
        && (!needle || onlineSearchText(index).includes(needle))
    ));
};

// ---- 本地 ----

export const LOCAL_SONG_COUNT = 8;
export const LOCAL_BASE_TIME = 1700000000000;
export const LOCAL_PLAYLIST_NAME = 'Probe Local Playlist';
/** 本地歌单里放的歌（按顺序）。 */
export const LOCAL_PLAYLIST_SONGS = [1, 2, 3, 4, 5, 6];

export const localSongId = (index: number): string => `probe-local-${index}`;
export const localSongTitle = (index: number): string => `Local ${PROBE_WORDS[index % PROBE_WORDS.length]} ${index}`;
export const localFolderName = (index: number): string => (index <= 5 ? 'Folder A' : 'Folder B');
export const localAlbumName = (index: number): string => (index <= 4 ? 'Alpha Album' : 'Beta Album');
/** 每张专辑内倒序编号：album-track 排序与文件名排序一定不同。 */
export const localTrackNumber = (index: number): number => (index <= 4 ? 5 - index : 9 - index);
/** 修改时间倒序：按修改时间排序与文件名排序一定不同。 */
export const localLastModified = (index: number): number => LOCAL_BASE_TIME + (LOCAL_SONG_COUNT + 1 - index) * 1000;

/** 四种排序在 All Songs 里的期望顺序（歌曲序号）。 */
export const LOCAL_SORT_ORDERS = {
    fileNameAsc: [1, 2, 3, 4, 5, 6, 7, 8],
    modifiedAsc: [8, 7, 6, 5, 4, 3, 2, 1],
    modifiedDesc: [1, 2, 3, 4, 5, 6, 7, 8],
    albumTrackDesc: [5, 6, 7, 8, 1, 2, 3, 4],
    albumTrackAsc: [4, 3, 2, 1, 8, 7, 6, 5],
} as const;

// ---- Navidrome ----

export const NAVIDROME_PROBE_SERVER = 'http://navidrome.probe';
export const NAVIDROME_ALBUM_ID = 'navi-al-1';
export const NAVIDROME_PLAYLIST_ID = 'navi-pl-1';
export const NAVIDROME_ALBUM_SONGS = range(6, 1).map(index => `navi-song-${index}`);
export const NAVIDROME_PLAYLIST_SONGS = range(5, 11).map(index => `navi-song-${index}`);
