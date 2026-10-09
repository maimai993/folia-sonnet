import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/utils/secureApiBase.test.ts

const stubLocation = (protocol: string) => {
    vi.stubGlobal('window', { location: { protocol } });
};

describe('upgradeInsecureApiBase', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('upgrades a cleartext backend when the page itself is served over https', async () => {
        stubLocation('https:');
        const { upgradeInsecureApiBase } = await import('@/utils/secureApiBase');

        // 自托管的明文服务常挂在 8080；同域的 https 入口几乎总在默认端口，端口要一并丢掉。
        expect(upgradeInsecureApiBase('http://folia.tangbot.xyz:8080/kugou'))
            .toBe('https://folia.tangbot.xyz/kugou');
    });

    it('leaves an already encrypted base alone', async () => {
        stubLocation('https:');
        const { upgradeInsecureApiBase } = await import('@/utils/secureApiBase');

        expect(upgradeInsecureApiBase('https://folia.tangbot.xyz/qq'))
            .toBe('https://folia.tangbot.xyz/qq');
    });

    // 页面本身是 http 时明文请求本来就能成功（网页版自建站点多是这样的），
    // 升级反而会把一个能用的地址改坏。
    it('leaves a cleartext base alone on a cleartext page', async () => {
        stubLocation('http:');
        const { upgradeInsecureApiBase } = await import('@/utils/secureApiBase');

        expect(upgradeInsecureApiBase('http://folia.tangbot.xyz:8080/kugou'))
            .toBe('http://folia.tangbot.xyz:8080/kugou');
    });

    // 回环地址是安全上下文：Electron 内嵌的 qq-music-api / KuGouMusicApi 就在 127.0.0.1 上，
    // 它们没有 https 可换，升级只会换来一次连接失败。
    it.each(['http://127.0.0.1:45123', 'http://localhost:3000'])('leaves loopback %s alone', async (base) => {
        stubLocation('https:');
        const { upgradeInsecureApiBase } = await import('@/utils/secureApiBase');

        expect(upgradeInsecureApiBase(base)).toBe(base);
    });

    // 同源部署写的是相对路径（如 `/api/qq`），没有协议可换，必须原样返回。
    it('leaves a relative same-origin base alone', async () => {
        stubLocation('https:');
        const { upgradeInsecureApiBase } = await import('@/utils/secureApiBase');

        expect(upgradeInsecureApiBase('/api/qq')).toBe('/api/qq');
    });
});
