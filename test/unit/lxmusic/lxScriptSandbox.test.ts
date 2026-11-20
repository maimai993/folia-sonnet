import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, shortFingerprint } from '../../../src/services/onlineMusic/lxmusic/lxFingerprint';
import { isAllowedLxRequestUrl } from '../../../src/services/onlineMusic/lxmusic/lxRequestGuard';

// test/unit/lxmusic/lxScriptSandbox.test.ts
// C2 的要点：脚本的请求要过一道闸，指纹要算得对（确认记录钉的是它）。
//
// 这一层不跑真的 worker（vitest 的 node 环境里没有 Worker）：它守的是「闸门的判断」与「指纹的算法」，
// 两处都纯函数，能在这里钉死。真机上脚本能不能跑通属于真机回归的事。

describe('the request guard in front of source scripts', () => {
    it('lets public hosts through', () => {
        expect(isAllowedLxRequestUrl('https://api.example.com/url?id=1')).toBe(true);
        expect(isAllowedLxRequestUrl('http://music.163.com/api/song/enhance/player/url')).toBe(true);
        // 公网 IP 也是公网：音源有直接写 IP 的。
        expect(isAllowedLxRequestUrl('https://8.8.8.8/x')).toBe(true);
        expect(isAllowedLxRequestUrl('https://1.1.1.1:8443/x')).toBe(true);
    });

    it('refuses anything that points back inside the network', () => {
        for (const url of [
            'http://localhost:8080/admin',
            'http://127.0.0.1/',
            'http://127.1.2.3/',
            'http://0.0.0.0/',
            'http://10.0.0.1/',
            'http://172.16.0.1/',
            'http://172.31.255.255/',
            'http://192.168.1.1/',
            'http://169.254.169.254/latest/meta-data/',
            'http://100.100.100.200/latest/meta-data/',
            'http://[::1]/',
            'http://[fe80::1]/',
            'http://[fd00::1]/',
            'http://[::ffff:127.0.0.1]/',
            'http://printer.local/',
            'http://router/',
            'http://nas:5000/',
            'http://api.internal/',
            'http://x.lan/',
        ]) {
            expect(isAllowedLxRequestUrl(url), url).toBe(false);
        }
    });

    it('refuses other protocols and userinfo tricks', () => {
        expect(isAllowedLxRequestUrl('file:///etc/passwd')).toBe(false);
        expect(isAllowedLxRequestUrl('content://media/external/audio/1')).toBe(false);
        expect(isAllowedLxRequestUrl('data:text/html,hi')).toBe(false);
        expect(isAllowedLxRequestUrl('javascript:alert(1)')).toBe(false);
        // http://public.example.com@127.0.0.1/ 真实主机是 127.0.0.1。
        expect(isAllowedLxRequestUrl('http://public.example.com@127.0.0.1/')).toBe(false);
        expect(isAllowedLxRequestUrl('not a url')).toBe(false);
    });

    it('treats 172.16/12 as private and 172.32/16 as public', () => {
        expect(isAllowedLxRequestUrl('http://172.15.0.1/')).toBe(true);
        expect(isAllowedLxRequestUrl('http://172.32.0.1/')).toBe(true);
    });
});

describe('the script fingerprint', () => {
    it('is the sha256 of the script text', async () => {
        for (const text of ['', 'abc', '晴天', 'a'.repeat(4096)]) {
            const want = createHash('sha256').update(text, 'utf8').digest('hex');
            await expect(sha256Hex(text)).resolves.toBe(want);
        }
    });

    it('changes when a single character changes, which is what forces a re-confirmation', async () => {
        const one = await sha256Hex('globalThis.lx; send("inited", { sources: {} })');
        const two = await sha256Hex('globalThis.lx; send("inited", { sources: {} });');
        expect(one).not.toBe(two);
    });

    it('shortens to the ends, so two versions look different at a glance', () => {
        const digest = 'a'.repeat(32) + 'b'.repeat(32);
        expect(shortFingerprint(digest)).toBe(`${'a'.repeat(8)}…${'b'.repeat(8)}`);
        expect(shortFingerprint('short')).toBe('short');
    });
});
