// test/unit/services/aiCloudCacheLive.test.ts
// 云缓存的**真服务**冒烟（issue：用户报「云缓存现在无法拉取了」）。
//
// 单测都是打桩的，证明不了「客户端发的东西服务端认」。这个用例用真实的客户端代码去打
// 真实的公共实例，只在显式打开时才跑：
//
//     FOLIA_CLOUD_LIVE=1 npx vitest run test/unit/services/aiCloudCacheLive.test.ts --maxWorkers=1
//
// 默认 skip 的理由是它要联网：CI 上网络抖动会让门禁红得莫名其妙。但改过云缓存的
// 客户端逻辑（地址、鉴权、写入条件）之后，值得手动跑一次 —— 它覆盖的正是打桩测不到的那段。
//
// 只读：只列歌名、只按已知的歌名筛，不写任何东西，不会污染公共实例。

import { describe, expect, it } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL, readFoliaCloudSettings } from '@/services/foliaCloud';
import { listAiCloudCacheSongs, resolveAiCloudCacheUrl } from '@/services/aiCloudCache';

const LIVE = process.env.FOLIA_CLOUD_LIVE === '1';

describe.skipIf(!LIVE)('云缓存真服务冒烟（需要 FOLIA_CLOUD_LIVE=1）', () => {
    it('内置地址是那个公开服务，且默认开启', () => {
        expect(DEFAULT_CLOUD_BASE_URL).toBe('https://apif.tangbot.xyz');
        expect(readFoliaCloudSettings()).toMatchObject({
            enabled: true,
            baseUrl: 'https://apif.tangbot.xyz',
        });
    });

    it('能真正拉到一份歌名列表', async () => {
        const page = await listAiCloudCacheSongs({ limit: 3 });
        /* 拉不到时这个函数按纪律返回空页而不是抛错，所以这里要断言拿到东西了。 */
        expect(page.songs.length).toBeGreaterThan(0);
        expect(page.total).toBeGreaterThan(0);
        expect(page.limit).toBe(3);
    });

    it('拉回来的条目字段形状对得上（页面直接拿去渲染的）', async () => {
        const page = await listAiCloudCacheSongs({ limit: 1 });
        const first = page.songs[0];
        expect(first).toBeTruthy();
        expect(typeof first?.songTitle).toBe('string');
        expect(first!.songTitle.length).toBeGreaterThan(0);
    });

    it('写入地址是按 kind + 32 位小写十六进制键拼出来的', () => {
        const url = resolveAiCloudCacheUrl('theme', 'abcdef0123456789abcdef0123456789');
        expect(url.startsWith('https://apif.tangbot.xyz')).toBe(true);
        expect(url).toContain('/api/ai-cache/theme/abcdef0123456789abcdef0123456789');
    });
});
