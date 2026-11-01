import { describe, expect, it } from 'vitest';
import { feiniuServerUrlForLoginInput, isBareFnId } from '@/services/onlineMusic/feiniuLoginInput';
import { feiniuServerUrlFromFnId } from '@/services/onlineMusic/feiniuTransport';

// test/unit/onlineMusic/feiniuLoginInput.test.ts
// 飞牛登录把「填 FN ID」和「填局域网地址」合成同一个输入框：第一栏收两种写法，
// 由内容决定走哪条路。这里钉住这个翻译 —— 这是「两接口合一」的全部增量，单独抽出来
// 不依赖整个 provider 图，所以能在单测里直接跑（不牵动歌词解析那一层）。

describe('which shape the first field is', () => {
    it('treats a dot-less code as an FN ID, everything else as an address', () => {
        // 域名有点、IP 也有点；只有 FN ID 是无点的短码。
        expect(isBareFnId('abcd1234')).toBe(true);
        expect(isBareFnId('myfnid')).toBe(true);
        // 地址种种都带点：IP、IP:端口、域名、整条 URL。
        expect(isBareFnId('nas.lan')).toBe(false);
        expect(isBareFnId('nas.lan:5666')).toBe(false);
        expect(isBareFnId('https://abcd1234.fnos.net')).toBe(false);
        expect(isBareFnId('abcd1234.fnos.net')).toBe(false);
        expect(isBareFnId('nas.example.com')).toBe(false);
    });

    it('ignores the scheme and trailing junk when judging the shape', () => {
        // 手抄带出来的空格、https、/music 尾巴都不该改变判定。
        expect(isBareFnId(' ABCD1234 ')).toBe(true);
        expect(isBareFnId('http://nas.lan:5666/music/')).toBe(false);
    });
});

describe('what the one field actually turns into', () => {
    it('turns a short code into the relay address', () => {
        expect(feiniuServerUrlForLoginInput('abcd1234')).toBe('https://abcd1234.fnos.net');
        expect(feiniuServerUrlForLoginInput('ABCD1234')).toBe('https://abcd1234.fnos.net');
        expect(feiniuServerUrlForLoginInput('abcd1234:8443')).toBe('https://abcd1234.fnos.net:8443');
    });

    it('hands a real address through untouched, because the port is decided later', () => {
        // 补协议和 5666 是 transport 里 withSchemeAndPort 的事：这里补一遍会把 https 改成 http。
        expect(feiniuServerUrlForLoginInput('nas.lan')).toBe('nas.lan');
        expect(feiniuServerUrlForLoginInput('http://nas.lan:5666/music/')).toBe('http://nas.lan:5666/music/');
        expect(feiniuServerUrlForLoginInput('https://nas.example.com')).toBe('https://nas.example.com');
    });

    it('answers nothing when nothing was typed', () => {
        expect(feiniuServerUrlForLoginInput('')).toBe('');
        expect(feiniuServerUrlForLoginInput(undefined)).toBeUndefined();
    });

    it('agrees with the raw transport helper on the relay case', () => {
        // 短码这一支就是直接交给 feiniuServerUrlFromFnId，结果必须一致。
        expect(feiniuServerUrlForLoginInput('abcd1234')).toBe(feiniuServerUrlFromFnId('abcd1234'));
    });
});
