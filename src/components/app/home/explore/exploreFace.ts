import type { OmniExploreItem } from '../../../../types/onlineMusic';
import { getProviderCollectionArtistLabel } from '../../../../library/core/home/homeCards';

// src/components/app/home/explore/exploreFace.ts
// How an entry of the explore tab reads: its title, its second line, its picture and that
// picture's shape. The tab's cards are drawn from it, and so are the wall's explore tiles
// (lattice/exploreWall.ts).

export interface Face {
    /** song, artist, album or playlist. */
    kind: string;
    title: string;
    /** The provider's own wording where it gives one. Else the artists' names; where an entry names none, what it is (artist, album, playlist). */
    subtitle: string;
    /** The picture shown: the entry's wide one where it has one, else its cover. */
    pictureUrl: string;
    /** The entry's own cover, which fills its frame to the edges: the one to blur into a glow. */
    coverUrl: string;
    shape: 'wide' | 'square' | 'round';
    /** A song's length; 0 for a card and for a song of unknown length. */
    durationMs: number;
}

/**
 * 一个可能带词条的名字。
 *
 * 先按 `home.` 那一组查（分区名、账号里那几个固定歌单都放在那里），查到就用词条；
 * 查不到就当作内容本身原样返回 —— 这一站的收藏夹名字是用户自己起的，不该被当成 key。
 */
const titleOf = (name: string, t: (key: string) => string): string => {
    const keyed = t(`home.${name}`);
    // i18next 查不到时会把 key 原样吐回来，那样就等于没查到。
    return keyed === `home.${name}` ? name : keyed;
};

export const faceOf = (item: OmniExploreItem, t: (key: string) => string): Face => {
    if (item.kind === 'song') {
        const coverUrl = item.song.album.coverUrl ?? '';
        return {
            kind: 'song',
            title: item.song.name,
            subtitle: item.subtitle ?? item.song.artists.map(artist => artist.name).filter(Boolean).join(', '),
            pictureUrl: item.wideCoverUrl ?? coverUrl,
            coverUrl,
            shape: item.wideCoverUrl ? 'wide' : 'square',
            durationMs: item.song.durationMs || 0,
        };
    }
    const { collection } = item;
    const isArtist = collection.type === 'artist';
    const kindLabel = t(isArtist ? 'home.exploreArtist' : collection.type === 'album' ? 'home.exploreAlbum' : item.isMix ? 'home.exploreMix' : 'home.explorePlaylist');
    const coverUrl = collection.coverUrl ?? '';
    // An artist is always its own cover in a circle.
    const wideCoverUrl = isArtist ? undefined : item.wideCoverUrl;
    return {
        kind: collection.type,
        // 歌单名可能是 i18n key（分区名、账号里那几个固定歌单），也可能就是内容本身
        // （「默认收藏夹」这种真实名字）。词条在 home 那一组里，所以带上前缀查；
        // 查不到就原样显示，不要把一个像变量名的东西摆到界面上。
        title: collection.name ? titleOf(collection.name, t) : collection.name,
        subtitle: item.subtitle ?? ((isArtist ? '' : getProviderCollectionArtistLabel(collection)) || kindLabel),
        pictureUrl: wideCoverUrl ?? coverUrl,
        coverUrl,
        shape: isArtist ? 'round' : wideCoverUrl ? 'wide' : 'square',
        durationMs: 0,
    };
};
