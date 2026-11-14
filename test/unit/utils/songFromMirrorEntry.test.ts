import { describe, expect, it } from 'vitest';
import { songFromMirrorEntry } from '../../../src/utils/queueMirrorEntry';

// test/unit/utils/songFromMirrorEntry.test.ts
// JS 醒来对齐队列时的反向映射：原生队列状态的一条 → SongResult。
//
// 映射错一个字段在真机上的表现都很隐蔽：artist 拆错了列表页显示成一个人，
// duration 搞错倍数进度条长度离谱，sourceRef 丢了点歌会走不了原生。

const entry = {
    songKey: 'qq:123',
    providerId: 'qq',
    songId: '123',
    mid: 'midABC',
    hash: '',
    albumAudioId: '',
    title: '歌名',
    artist: 'A / B',
    album: '专辑',
    coverUrl: 'https://example.com/cover.jpg',
    durationSec: 210,
};

describe('songFromMirrorEntry', () => {
    it('还原歌名、专辑、时长', () => {
        const song = songFromMirrorEntry(entry);
        expect(song.name).toBe('歌名');
        expect(song.album.name).toBe('专辑');
        expect(song.durationMs).toBe(210000);
    });

    it('多个歌手按 / 拆开', () => {
        const song = songFromMirrorEntry(entry);
        expect(song.artists.map(a => a.name)).toEqual(['A', 'B']);
    });

    it('时长以秒来的换算成毫秒，0 不变负', () => {
        expect(songFromMirrorEntry({ ...entry, durationSec: 0 }).durationMs).toBe(0);
        expect(songFromMirrorEntry({ ...entry, durationSec: 3.5 }).durationMs).toBe(3500);
    });

    it('sourceRef 带回平台身份，再次下发原生认得出', () => {
        const song = songFromMirrorEntry(entry);
        const ref = song.sourceRef as { kind: string; providerId: string; mediaId: string; providerData: Record<string, unknown> };
        expect(ref.kind).toBe('online');
        expect(ref.providerId).toBe('qq');
        // QQ 取流认 songmid：这个字段丢了原生就解析不出地址。
        expect(ref.providerData.songmid).toBe('midABC');
        expect(ref.providerData.songId).toBe('123');
    });

    it('酷狗只有 hash 时 mediaId 落到 hash 上', () => {
        const song = songFromMirrorEntry({ ...entry, providerId: 'kugou', songId: '', mid: '', hash: 'kgHASH' });
        expect(song.id).toBe('kgHASH');
        const ref = song.sourceRef as { providerData: Record<string, unknown> };
        expect(ref.providerData.hash).toBe('kgHASH');
    });

    it('空歌手不产生空名字的 artist', () => {
        expect(songFromMirrorEntry({ ...entry, artist: '' }).artists).toEqual([]);
    });
});
