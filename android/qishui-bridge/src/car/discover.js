// android/qishui-bridge/src/car/discover.js
//
// 手机端「发现 → 模式探索」那一屏：beta-luna.douyin.com/luna/discover。
//
// 这条路和车机协议（open.douyin.com/api/luna/v1/platform/*）完全无关：它是汽水 App
// 自己的公开接口，POST 一个空对象就能拿回一组随时会换的推荐卡（title + desc + 封面），
// 不需要登录，也不需要车机那套 client token。真机上仍走原生 http 桥（见 transport.js），
// 所以不涉及跨域；桌面端没这条桥时前端会自己跳过。
//
// 点开某张卡之后用 /luna/feed/radio/tracks 拉那个 radio queue 的歌，同样是公开的。

import { QishuiError } from './client.js';

const DISCOVER_HOST = 'https://beta-luna.douyin.com/luna';
const DISCOVER_UA = 'Luna/19.1.0 Android';

/**
 * 模式探索卡的封面 uri 是 `.JPG/.png` 原图后缀，必须配 `~<template>-image.image`；
 * 公共的 coverFromUrlInfo 用的是 `~c5_<w>x<h>.jpeg`，那是歌单/歌曲桶的后缀，
 * 套到这张图上会 403。实测这条拼法返回 200 image/jpeg。
 */
function modeCover(info) {
    if (!info || typeof info !== 'object') return '';
    const urls = Array.isArray(info.urls) ? info.urls : [];
    const prefix = urls.find(value => typeof value === 'string' && /^https:\/\//.test(value)) || '';
    const uri = String(info.uri || '');
    const template = String(info.template_prefix || '');
    if (!prefix || !uri || !template) return '';
    return `${prefix}${uri}~${template}-image.image`;
}

export function createDiscover({ client }) {
    const post = async (path, body) => {
        const { data } = await client.http(`${DISCOVER_HOST}${path}`, {
            body,
            headers: { 'user-agent': DISCOVER_UA, 'content-type': 'application/json; charset=utf-8' },
        });
        return data;
    };

    return {
        /**
         * 模式探索的卡片。上游把卡片放在第一个 block 的 inner_block 里，每张卡
         * 的 resources[0] 是一个 radio：id / title / desc / cover_url_list[0]。
         * 返回 Folia 渲染层好消化的扁平形状；没有资源就跳过，不抛。
         */
        async modes() {
            const data = await post('/discover', {});
            const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
            const inner = blocks.flatMap(block => (Array.isArray(block.inner_block) ? block.inner_block : []));
            const cards = [];
            for (const entry of inner) {
                const resource = Array.isArray(entry.resources) ? entry.resources[0] : null;
                const id = String(resource?.resource_id || '');
                const style = resource?.style || {};
                const name = String(style.title || entry.title || '');
                if (!id || !name) continue;
                const coverInfo = Array.isArray(style.cover_url_list) ? style.cover_url_list[0] : null;
                cards.push({
                    id,
                    name,
                    description: String(style.desc || ''),
                    cover: modeCover(coverInfo),
                    color: String(style.cover_color?.dominant_color?.rgb || ''),
                });
            }
            return cards;
        },

        /** 某张模式卡下的曲目；上游按 cursor 翻页。 */
        async tracks(radioId, limit, cursor) {
            const id = String(radioId || '');
            if (!/^\d+$/.test(id)) throw new QishuiError('invalid-response', 'Invalid radio id');
            const data = await post('/feed/radio/tracks', {
                radio_id: id,
                count: Math.min(Math.max(Number(limit) || 20, 1), 50),
                cursor: String(cursor || ''),
            });
            const items = Array.isArray(data?.items) ? data.items : [];
            const songs = [];
            for (const item of items) {
                // 手机端 track 是扁平的 {id,name,duration,artists,album}，跟车机的
                // base_info / related_info 那套完全不同，这里单独映射一次。
                const track = item?.entity?.track_wrapper?.track;
                if (!track) continue;
                const id = String(track.id || '');
                if (!id) continue;
                const artists = Array.isArray(track.artists) ? track.artists : [];
                const album = track.album || {};
                songs.push({
                    id,
                    name: String(track.name || ''),
                    artist: artists.map(a => String(a.name || '')).filter(Boolean).join(' / '),
                    artistId: String(artists[0]?.id || ''),
                    artists: artists.filter(a => a.name).map(a => ({ id: String(a.id || ''), name: String(a.name) })),
                    album: String(album.name || ''),
                    albumId: String(album.id || ''),
                    cover: modeCover(album.url_cover),
                    // 渲染层拿到秒再乘 1000。
                    duration: Number(track.duration || 0) / 1000,
                    fee: 0,
                    playbackMode: 'direct-url',
                });
            }
            return { songs, hasMore: data?.has_more === true, cursor: String(data?.next_cursor || '') };
        },
    };
}

export default { createDiscover };
