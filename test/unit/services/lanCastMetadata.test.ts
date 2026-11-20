import { describe, expect, it } from 'vitest';
import {
    describeLanCastMedia,
    describeLanCastTrimming,
    detectLanCastAudioFormat,
} from '../../../src/services/lanCastMetadata';

// test/unit/services/lanCastMetadata.test.ts
// 投送声明给音响的媒体元数据（issue M23）。验收标准逐条钉住：
// 投送 FLAC 时 protocolInfo 不再是 audio/mpeg；认不出时回退 MP3 但不编 profile；
// 被裁掉的元数据能被前端感知。
describe('lanCast 投送元数据', () => {
    it('投送 FLAC 时 protocolInfo 不再是 audio/mpeg', () => {
        const media = describeLanCastMedia('http://192.168.1.5:45678/song.flac');
        expect(media.format).toBe('flac');
        expect(media.protocolInfo).not.toContain('audio/mpeg');
        expect(media.protocolInfo).toBe('http-get:*:audio/flac:DLNA.ORG_PN=FLAC');
    });

    it('各容器声明各自的 MIME', () => {
        const cases: Array<[string, string]> = [
            ['a.mp3', 'audio/mpeg'],
            ['a.flac', 'audio/flac'],
            ['a.m4a', 'audio/mp4'],
            ['a.aac', 'audio/mp4'],
            ['a.alac', 'audio/mp4'],
            ['a.wav', 'audio/wav'],
            ['a.ogg', 'audio/ogg'],
            ['a.opus', 'audio/ogg'],
        ];
        for (const [path, mime] of cases) {
            const { protocolInfo } = describeLanCastMedia(`http://10.0.0.2:49152/${path}`);
            expect(protocolInfo, path).toContain(`:${mime}:`);
        }
    });

    it('扩展名忽略大小写，且不被查询串干扰', () => {
        expect(detectLanCastAudioFormat('http://h/a.FLAC')).toBe('flac');
        expect(detectLanCastAudioFormat('http://h/a.flac?token=abc&x=1')).toBe('flac');
    });

    it('主机名里的点不算扩展名', () => {
        // `speaker.local/stream` 过去会被误判成 `.local` 扩展名。
        expect(detectLanCastAudioFormat('http://speaker.local/stream')).toBeNull();
    });

    it('中转地址靠 type 参数认格式', () => {
        // `/remote-audio/<token>` 没有扩展名，格式只能从参数来。
        expect(detectLanCastAudioFormat('http://h:45678/remote-audio/abc?type=flac')).toBe('flac');
        expect(detectLanCastAudioFormat('http://h:45678/remote-audio/abc?type=audio/flac')).toBe('flac');
    });

    it('参数说了是什么就按参数，不信路径上那个', () => {
        expect(detectLanCastAudioFormat('http://h/a.flac?format=mp3')).toBe('mp3');
    });

    it('认不出格式时回退 MP3，但不编一个 profile', () => {
        const media = describeLanCastMedia('http://h:45678/remote-audio/abc');
        expect(media.format).toBeNull();
        // 编一个 DLNA.ORG_PN 比不写更容易被音响拒。
        expect(media.protocolInfo).toBe('http-get:*:audio/mpeg:*');
    });

    it('protocolInfo 始终是四段', () => {
        // 字段数写错，音响直接不认这条 res。
        for (const url of ['http://h/a.flac', 'http://h/a.mp3', 'http://h/stream']) {
            expect(describeLanCastMedia(url).protocolInfo.split(':')).toHaveLength(4);
        }
    });

    describe('元数据裁剪', () => {
        it('封面不是 http 地址时算被裁掉', () => {
            // blob: / data: 本地封面音响拿不到，原生不会写 albumArtURI。
            expect(describeLanCastTrimming({ coverUrl: 'blob:http://localhost/abc' })).toContain('cover');
            expect(describeLanCastTrimming({ coverUrl: 'data:image/png;base64,xx' })).toContain('cover');
            expect(describeLanCastTrimming({ coverUrl: '' })).toContain('cover');
        });

        it('http(s) 封面不算被裁', () => {
            expect(describeLanCastTrimming({ coverUrl: 'https://cdn.example/a.jpg' })).not.toContain('cover');
            expect(describeLanCastTrimming({ coverUrl: 'http://192.168.1.5:45678/cover' })).not.toContain('cover');
        });

        it('空字段算被裁，顺序固定', () => {
            expect(describeLanCastTrimming({ title: '', artist: '', album: '', coverUrl: 'https://a/b.jpg' }))
                .toEqual(['title', 'artist', 'album']);
        });

        it('齐全时什么都不裁', () => {
            expect(describeLanCastTrimming({
                title: 't', artist: 'a', album: 'b', coverUrl: 'https://a/b.jpg',
            })).toEqual([]);
        });
    });
});
