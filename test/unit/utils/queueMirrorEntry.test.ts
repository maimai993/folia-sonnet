import { describe, expect, it } from 'vitest';
import type { SongResult } from '../../../src/types';
import {
    buildQueueMirrorEntries,
    buildQueueMirrorEntry,
    getMirrorDurationMs,
    resolveLikeIdentity,
} from '../../../src/utils/queueMirrorEntry';
import { getPlaybackSongKey } from '../../../src/utils/appPlaybackGuards';

/*
 * 原生镜像的字段契约（queueMirrorEntry.ts 与 FoliaPlaybackService 的镜像解析一一对应）。
 *
 * 这些字段是 WebView 冻结之后原生唯一知道「这首歌是哪个平台的哪一首」的来路，错一个
 * 就是通知栏切歌切到错的一首、或者那颗心写不进账号。所以这里按平台逐条钉住。
 */

const online = (providerId: string, mediaId: string, providerData?: Record<string, unknown>): SongResult => ({
    id: mediaId,
    name: 'Song',
    sourceRef: { kind: 'online', providerId, mediaId, ...(providerData ? { providerData } : {}) },
} as unknown as SongResult);

describe('resolveLikeIdentity', () => {
    it('gives nothing for songs with no platform identity', () => {
        const none = { providerId: '', serverSongId: '', providerMid: '', providerHash: '', providerAlbumAudioId: '' };
        expect(resolveLikeIdentity(null)).toEqual(none);
        expect(resolveLikeIdentity(undefined)).toEqual(none);
        // 自家人（本地 / Navidrome / 舞台）没有 sourceRef.kind === 'online'：原生兜底对它们跳过。
        expect(resolveLikeIdentity({ id: '1', name: 'x', sourceRef: { kind: 'local', path: '/a.mp3' } } as unknown as SongResult)).toEqual(none);
    });

    it('uses the numeric catalogue id for netease', () => {
        expect(resolveLikeIdentity(online('netease', '12345')).serverSongId).toBe('12345');
        expect(resolveLikeIdentity(online('netease', '12345')).providerId).toBe('netease');
    });

    it('prefers a numeric songId for qq and falls back to a numeric mediaId', () => {
        // 正规化时把数字 songId 存进 providerData；写入收藏只认它。
        expect(resolveLikeIdentity(online('qq', 'cD1aBcD2', { songId: '987' })).serverSongId).toBe('987');
        // 没有 songId 时 mediaId 只要是数字就能当 id。
        expect(resolveLikeIdentity(online('qq', '456')).serverSongId).toBe('456');
        // songmid 形态的 mediaId 不是数字，不能拿去做收藏 id，但取流要它。
        const mid = resolveLikeIdentity(online('qq', 'cD1aBcD2'));
        expect(mid.serverSongId).toBe('');
        expect(mid.providerMid).toBe('cD1aBcD2');
    });

    it('rejects a qq songId that is not a plain number', () => {
        // 上游脏数据不能拼进收藏请求：`/^\d{1,15}$/` 之外的取值一律当没有。
        expect(resolveLikeIdentity(online('qq', 'abc', { songId: '../evil' })).serverSongId).toBe('');
        expect(resolveLikeIdentity(online('qq', 'abc', { songId: '9999999999999999' })).serverSongId).toBe('');
        expect(resolveLikeIdentity(online('qq', 'abc', { songId: ' 42 ' })).serverSongId).toBe('42');
    });

    it('takes songmid from providerData when it is there', () => {
        expect(resolveLikeIdentity(online('qq', 'ignored', { songmid: 'real-mid' })).providerMid).toBe('real-mid');
    });

    it('keys kugou on the file hash and keeps the album audio id', () => {
        const both = resolveLikeIdentity(online('kugou', 'md5', { hash: 'abc123', albumAudioId: '77' }));
        expect(both.providerHash).toBe('abc123');
        expect(both.providerAlbumAudioId).toBe('77');
        // albumAudioId 是数字时也要转成字符串：原生按字符串解析。
        expect(resolveLikeIdentity(online('kugou', 'md5', { albumAudioId: 77 })).providerAlbumAudioId).toBe('77');
        // 没有 hash 时退回 mediaId（酷歌的 mediaId 本来就是 hash）。
        expect(resolveLikeIdentity(online('kugou', 'fallbackHash')).providerHash).toBe('fallbackHash');
    });

    it('uses the single track id for qishui and feiniu', () => {
        expect(resolveLikeIdentity(online('qishui', 'track-1')).serverSongId).toBe('track-1');
        expect(resolveLikeIdentity(online('feiniu', 'guid-1')).serverSongId).toBe('guid-1');
        expect(resolveLikeIdentity(online('feiniu', 'guid-1')).providerId).toBe('feiniu');
    });
});

describe('getMirrorDurationMs', () => {
    it('prefers durationMs over duration', () => {
        expect(getMirrorDurationMs({ durationMs: 200_000, duration: 111 } as unknown as SongResult)).toBe(200_000);
    });

    it('scales a duration that is plainly in seconds', () => {
        // 有些音源给的是秒：200 是 200 秒，不是 200 毫秒。
        expect(getMirrorDurationMs({ duration: 200 } as unknown as SongResult)).toBe(200_000);
    });

    it('returns zero for anything unusable', () => {
        expect(getMirrorDurationMs({} as SongResult)).toBe(0);
        expect(getMirrorDurationMs({ durationMs: NaN } as unknown as SongResult)).toBe(0);
        expect(getMirrorDurationMs({ durationMs: Infinity } as unknown as SongResult)).toBe(0);
    });
});

describe('buildQueueMirrorEntry', () => {
    it('carries the identity, the labels and the like state', () => {
        const song = {
            ...online('qq', 'cD1aBcD2', { songId: '987' }),
            name: 'Title',
            singer: 'Singer',
            album: 'Album',
        } as unknown as SongResult;
        const entry = buildQueueMirrorEntry(song, () => ({ liked: true, canLike: true }));
        expect(entry.songKey).toBe(getPlaybackSongKey(song));
        expect(entry.title).toBe('Title');
        expect(entry.providerId).toBe('qq');
        expect(entry.serverSongId).toBe('987');
        expect(entry.providerMid).toBe('cD1aBcD2');
        expect(entry.liked).toBe(true);
        expect(entry.canLike).toBe(true);
    });

    it('treats an absent or undefined like state as "not liked, cannot like"', () => {
        const song = online('netease', '1');
        // 没有 likeStateOf：不是「不知道」，而是明确的两条 false。
        expect(buildQueueMirrorEntry(song).liked).toBe(false);
        expect(buildQueueMirrorEntry(song).canLike).toBe(false);
        // likeStateOf 回 undefined 时同理 —— 原生那边按布尔读，容不下 null。
        expect(buildQueueMirrorEntry(song, () => undefined).liked).toBe(false);
        expect(buildQueueMirrorEntry(song, () => null).canLike).toBe(false);
    });

    it('builds one entry per song, in order', () => {
        const list = [online('netease', '1'), online('kugou', 'h2')];
        const entries = buildQueueMirrorEntries(list, (song) => ({ liked: song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'kugou', canLike: true }));
        expect(entries).toHaveLength(2);
        expect(entries[0].liked).toBe(false);
        expect(entries[1].liked).toBe(true);
    });
});
