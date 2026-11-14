import { describe, expect, it } from 'vitest';
import { getOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import {
    feiniuFnIdFromServerUrl,
    feiniuServerUrlFromFnId,
    isFeiniuRelayAddress,
    isFnConnectLoginPage,
    normalizeFeiniuServerUrl,
} from '@/services/onlineMusic/feiniuTransport';
import { feiniuServerUrlForLoginInput } from '@/services/onlineMusic/feiniuLoginInput';

// test/unit/onlineMusic/feiniuLoginMethods.test.ts
// 飞牛的登录只有一个输入框：人在外面记得住 FN ID，人在家里抄得到 IP:端口 ——
// 两种写法落在同一栏里，由内容决定走哪条路。这里钉住这个翻译：
// 手抄错一点（多了空格、写了 https、带端口、带 /music 尾巴）都要难不倒它。

describe('an FN ID becomes the address of that machine', () => {
    it('adds the relay domain the vendor hands out, and speaks https', () => {
        // 中继域名是飞牛自己的 fnos.net（实测：abcd1234.fnos.net 在多个公共 DNS 上都解析得到，
        // 而 abcd1234.5ddd.com 一律 NXDOMAIN —— 5ddd.com 是上一代通道）。写错后缀的报法最坏：
        // DNS 直接解析不了，界面只说「连不上」，看着像 NAS 没开机。所以这个后缀必须钉住。
        expect(feiniuServerUrlFromFnId('abcd1234')).toBe('https://abcd1234.fnos.net');
        expect(feiniuServerUrlFromFnId(' ABCD1234 ')).toBe('https://abcd1234.fnos.net');
    });

    it('leaves an address that is already one alone, and keeps the scheme it was written with', () => {
        // 用户从浏览器地址栏复制来的往往是整条：域名已经在里面，不该再补一次后缀。
        expect(feiniuServerUrlFromFnId('https://abcd1234.fnos.net/')).toBe('https://abcd1234.fnos.net');
        // 自己的局域网写着 http 就还是 http：连自己域名的人知道自己在连哪里，别替他改成 https。
        expect(feiniuServerUrlFromFnId('http://nas.lan:5666/music/')).toBe('http://nas.lan:5666');
        expect(feiniuServerUrlFromFnId('abcd1234.fnos.net:8443')).toBe('https://abcd1234.fnos.net:8443');
    });

    it('is empty when nothing was typed', () => {
        expect(feiniuServerUrlFromFnId('')).toBe('');
        expect(feiniuServerUrlFromFnId('   ')).toBe('');
    });

    it('survives the paste that comes with a full-width colon', () => {
        expect(feiniuServerUrlFromFnId('abcd1234.fnos.net：8443')).toBe('https://abcd1234.fnos.net:8443');
    });
});

describe('the other way round: whether an address is one of those', () => {
    it('answers the ID for a machine reached through either relay domain', () => {
        expect(feiniuFnIdFromServerUrl('https://abcd1234.fnos.net')).toBe('abcd1234');
        expect(feiniuFnIdFromServerUrl('abcd1234.fnos.net:8443/music')).toBe('abcd1234');
        // 上一代通道连过的旧地址也要认得出（预填那一栏用）。
        expect(feiniuFnIdFromServerUrl('abcd1234.5ddd.com')).toBe('abcd1234');
        // 局域网地址不是 FN ID：那一栏不该被它填上。
        expect(feiniuFnIdFromServerUrl('http://nas.lan:5666')).toBe('');
        expect(feiniuFnIdFromServerUrl('')).toBe('');
    });
});

describe('whether an address goes through the relay', () => {
    // 走中继的请求（含登录那一发）必须带 `mode=relay`，否则网关 302 掉。实测 fnos.net：
    // 带 → 200 + JSON；不带 → 302 + nginx 的 HTML。
    it('is true for both relay domains, and only for them', () => {
        expect(isFeiniuRelayAddress('https://abcd1234.fnos.net')).toBe(true);
        expect(isFeiniuRelayAddress('abcd1234.5ddd.com')).toBe(true);
        expect(isFeiniuRelayAddress('http://nas.lan:5666')).toBe(false);
        expect(isFeiniuRelayAddress('nas.lan:5666')).toBe(false);
        // 自己的 DDNS 域名是直连，不是中继。
        expect(isFeiniuRelayAddress('nas.example.com')).toBe(false);
        expect(isFeiniuRelayAddress('')).toBe(false);
    });
});

describe('the address typed the other way is left as it is', () => {
    it('keeps http together with its default port', () => {
        expect(normalizeFeiniuServerUrl(' http://nas.lan:5666/music/ ')).toBe('http://nas.lan:5666');
    });
});

describe('a page the gateway hands back instead of an answer', () => {
    // 网关不放行时给的是一页 HTML。认得出它，界面才能说「网关把请求拨走了」，
    // 而不是「这个地址上没有服务」。
    const gateway = '<!doctype html><html lang="zh-CN"><head>'
        + '<link rel="icon" href="https://static2.fnnas.com/connect/favicon.ico"/>'
        + '<title>FN Connect 远程访问 - 飞牛 fnOS</title></head><body><div id="app"></div></body></html>';

    it('knows the gateway login page when it sees one', () => {
        expect(isFnConnectLoginPage(gateway)).toBe(true);
    });

    it('leaves any other page alone, so a wrong address still says service not found', () => {
        expect(isFnConnectLoginPage('<html><head><title>fnOS</title></head><body>登录</body></html>')).toBe(false);
        expect(isFnConnectLoginPage('')).toBe(false);
    });

    it('does not catch the relay turning a request away — that one is told by its status, not its text', () => {
        // fnos.net 网关拦下请求的方式是 302 + nginx 那一页（实测），它不带 FN Connect 的字样：
        // 这一页只能按状态码认（feiniuRequest 里 3xx + HTML 的那一段）。
        const nginx = '<html>\n<head><title>302 Found</title></head>\n<body>\n'
            + '<center><h1>302 Found</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>';
        expect(isFnConnectLoginPage(nginx)).toBe(false);
    });
});

describe('what the one field actually turns into', () => {
    // 合并不是"两种写法都丢给 feiniuServerUrlFromFnId"：那会把地址拼成
    // `https://nas.lan`（443），而 NAS 的音乐服务在 5666 的 http 上。
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
});

describe('the sign-in a platform of this kind declares', () => {
    const auth = getOnlineMusicProvider('feiniu')!.auth!;

    it('declares no method of its own, so the window opens straight on the one form', () => {
        // 「填 FN ID」和「填地址」对用户是同一件事：NAS 在哪。声明了方式，界面就会先停一屏
        // 等用户挑一个 —— 挑错只换来一句「连不上」，而那句话对两种错法一模一样。
        // 没有方式时走的是控制器里那条「一张表单」的路（method 为 null）。
        expect(auth.getLoginMethods!()).toEqual([]);
    });

    it('still asks for the address, because this platform lives wherever the user says it does', () => {
        expect(getOnlineMusicProvider('feiniu')!.capabilities).toMatchObject({
            passwordLogin: true,
            passwordLoginServerUrl: true,
        });
    });
});
