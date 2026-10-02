import type { SubsonicSong } from '../../../src/types/navidrome';
import {
    NAVIDROME_ALBUM_ID,
    NAVIDROME_ALBUM_SONGS,
    NAVIDROME_PLAYLIST_ID,
    NAVIDROME_PLAYLIST_SONGS,
    NAVIDROME_PROBE_SERVER,
} from './fixtureRules';
import { recordProbeRequest } from './probeLog';

// dev/probes/libraryBehavior/navidromeShim.ts
// 只在沙盒模式安装的 fetch 垫片：把发往 http://navidrome.probe 的 Subsonic 请求就地应答。
// 放在探针里而不是 Playwright 的 page.route，是为了手动打开探针时也能用同一份数据。

export const NAVIDROME_PROBE_CONFIG = {
    serverUrl: NAVIDROME_PROBE_SERVER,
    username: 'probe',
    passwordHash: 'probe-password',
};

const makeSubsonicSong = (id: string, index: number, album: string, albumId: string): SubsonicSong => ({
    id,
    isDir: false,
    title: `Navi ${id}`,
    album,
    albumId,
    artist: 'Navi Artist',
    artistId: 'navi-ar-1',
    track: index + 1,
    size: 1024,
    contentType: 'audio/mpeg',
    suffix: 'mp3',
    duration: 200 + index,
    path: `navi/${id}.mp3`,
    created: '2026-01-01T00:00:00Z',
    type: 'music',
    isVideo: false,
});

let playlistEntries: string[] = [];

const respond = (body: unknown) => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body as object } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});

const coverSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7c3aed"/></svg>';

// 应答一条 Subsonic 请求；未知端点按空的 ok 应答，和真实服务器的宽松程度一致。
const handle = (url: URL): Response => {
    const endpoint = url.pathname.replace('/rest/', '');
    if (endpoint === 'getCoverArt') {
        return new Response(coverSvg, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
    }

    const id = url.searchParams.get('id') ?? url.searchParams.get('playlistId') ?? undefined;
    const removing = url.searchParams.getAll('songIndexToRemove').map(Number);
    recordProbeRequest({
        provider: 'navidrome',
        op: endpoint,
        target: id,
        ...(removing.length > 0 ? { ids: removing.map(String) } : {}),
        outcome: 'ok',
    });

    if (endpoint === 'getAlbum' && id === NAVIDROME_ALBUM_ID) {
        return respond({
            album: {
                id: NAVIDROME_ALBUM_ID,
                name: 'Navi Album',
                artist: 'Navi Artist',
                artistId: 'navi-ar-1',
                songCount: NAVIDROME_ALBUM_SONGS.length,
                duration: 1200,
                created: '2026-01-01T00:00:00Z',
                song: NAVIDROME_ALBUM_SONGS.map((songId, index) => makeSubsonicSong(songId, index, 'Navi Album', NAVIDROME_ALBUM_ID)),
            },
        });
    }
    if (endpoint === 'getPlaylist' && id === NAVIDROME_PLAYLIST_ID) {
        return respond({
            playlist: {
                id: NAVIDROME_PLAYLIST_ID,
                name: 'Navi Playlist',
                owner: 'probe',
                songCount: playlistEntries.length,
                duration: 1000,
                entry: playlistEntries.map((songId, index) => makeSubsonicSong(songId, index, 'Navi Mixed', 'navi-al-2')),
            },
        });
    }
    if (endpoint === 'getPlaylists') {
        return respond({
            playlists: {
                playlist: [{ id: NAVIDROME_PLAYLIST_ID, name: 'Navi Playlist', owner: 'probe', songCount: playlistEntries.length, duration: 1000 }],
            },
        });
    }
    if (endpoint === 'updatePlaylist') {
        const removingSet = new Set(removing);
        playlistEntries = playlistEntries.filter((_, index) => !removingSet.has(index));
    }
    return respond({});
};

/** 安装垫片，返回卸载函数。 */
export const installNavidromeShim = (): (() => void) => {
    playlistEntries = [...NAVIDROME_PLAYLIST_SONGS];
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (raw.startsWith(`${NAVIDROME_PROBE_SERVER}/rest/`)) {
            return handle(new URL(raw));
        }
        return originalFetch(input, init);
    };
    return () => {
        window.fetch = originalFetch;
    };
};
