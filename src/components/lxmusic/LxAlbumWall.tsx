import { Disc3, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
    LX_PUBLIC_PLATFORMS,
    type LxPublicPlatform,
} from '../../services/onlineMusic/lxmusic/lxPublicApi';
import { ensureLxLikedSongsHydrated, getLxLikedSongs, subscribeLxLikedSongs } from '../../services/onlineMusic/lxmusic/lxLikedSongs';
import { getLxSavedPlaylists, subscribeLxSavedPlaylists, type LxSavedSong } from '../../services/onlineMusic/lxmusic/lxSavedPlaylists';
import { LxGlassCardRail } from './LxGlassRail';

// src/components/lxmusic/LxAlbumWall.tsx
// 首页「专辑」页签在洛雪下的形态：洛雪没有「用户专辑库」，但用户确实收藏了歌，
// 那些歌各自属于某张专辑 —— 这一页就是把这些专辑拼成一面封面墙。
//
// 数据来自两处本机收藏：点过喜欢的歌（lxLikedSongs）+ 自己建过的歌单里的歌（lxSavedPlaylists）。
// 按「平台 + 平台原生专辑 id」归并（没有 id 时退回专辑名），所以同一个平台上同一张专辑只出现一次。
// 点一张专辑直接打开那家的专辑页（曲目、播放都在那里），比在这里另造一个曲目表更实在。

const platformLabel = (key: string): string => (
    LX_PUBLIC_PLATFORMS.find((item) => item.key === key)?.label ?? key
);

type AlbumEntry = {
    key: string;
    platform: string;
    albumId?: string;
    name: string;
    coverUrl?: string;
    count: number;
};

const collectSavedSongs = (): LxSavedSong[] => {
    const seen = new Set<string>();
    const out: LxSavedSong[] = [];
    const push = (song: LxSavedSong): void => {
        if (!song?.mediaId || seen.has(song.mediaId)) return;
        seen.add(song.mediaId);
        out.push(song);
    };
    getLxLikedSongs().forEach(push);
    getLxSavedPlaylists().forEach((playlist) => playlist.songs.forEach(push));
    return out;
};

const buildAlbums = (songs: LxSavedSong[]): AlbumEntry[] => {
    const map = new Map<string, AlbumEntry>();
    songs.forEach((song) => {
        const albumName = (song.albumName ?? '').trim() || '未知专辑';
        const key = `${song.platform}:${song.albumId ?? albumName}`;
        const current = map.get(key);
        if (current) {
            current.count += 1;
            if (!current.coverUrl && song.coverUrl) current.coverUrl = song.coverUrl;
            return;
        }
        map.set(key, {
            key,
            platform: song.platform,
            albumId: song.albumId,
            name: albumName,
            coverUrl: song.coverUrl,
            count: 1,
        });
    });
    // 没有原生专辑 id 的（老版本只存了 id、元数据没补全）进不了那张专辑页，
    // 一张点了没反应的卡不如不画：直接不进墙，免得看着像坏掉的灰方块。
    // 收藏得多的专辑排前面：那才是用户真在听的。
    return Array.from(map.values())
        .filter((album) => Boolean(album.albumId))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

type LxAlbumWallProps = {
    onOpenAlbum: (platform: LxPublicPlatform, albumId: string, name: string, coverUrl?: string) => void;
};

export const LxAlbumWall = ({ onOpenAlbum }: LxAlbumWallProps) => {
    const [albums, setAlbums] = useState<AlbumEntry[]>(() => buildAlbums(collectSavedSongs()));
    const [hydrating, setHydrating] = useState(false);

    const rebuild = useCallback(() => {
        setAlbums(buildAlbums(collectSavedSongs()));
    }, []);

    useEffect(() => {
        const offLiked = subscribeLxLikedSongs(rebuild);
        const offPlaylists = subscribeLxSavedPlaylists(rebuild);
        return () => { offLiked(); offPlaylists(); };
    }, [rebuild]);

    // 老版本点喜欢时只存了 id：补一次元数据（内部异步，补到会触发上面的订阅重画）。
    // 水合没有 Promise 可等，用一个短计时兜住转圈：真实补到之后墙会自己重画。
    useEffect(() => {
        setHydrating(true);
        ensureLxLikedSongsHydrated();
        const timer = window.setTimeout(() => setHydrating(false), 1500);
        return () => { window.clearTimeout(timer); };
    }, []);

    if (albums.length === 0) {
        return (
            <div className="w-full h-full flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
                {hydrating ? <Loader2 className="animate-spin opacity-40" size={22} /> : <Disc3 className="opacity-30" size={28} />}
                <div className="text-xs opacity-50">
                    还没有收藏歌曲。在曲目上点心形收藏之后，它的专辑会出现在这里。
                </div>
            </div>
        );
    }

    const cards = albums.map((album) => ({
        key: album.key,
        title: album.name,
        caption: `${album.count} 首 · ${platformLabel(album.platform)}`,
        coverUrl: album.coverUrl,
    }));

    return (
        <div className="w-full h-full flex-1 flex flex-col justify-center min-h-0 pb-6" data-lx-album-wall>
            <LxGlassCardRail
                items={cards}
                onSelect={(key) => {
                    const album = albums.find((entry) => entry.key === key);
                    if (!album?.albumId) return;
                    onOpenAlbum(album.platform as LxPublicPlatform, album.albumId, album.name, album.coverUrl);
                }}
                width={262}
                testId="albums"
            />
            <div className="text-center text-[11px] opacity-35 select-none">左右滑动查看更多专辑</div>
        </div>
    );
};

export default LxAlbumWall;
