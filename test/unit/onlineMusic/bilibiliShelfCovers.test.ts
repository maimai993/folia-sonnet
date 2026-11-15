import { describe, expect, it, vi, beforeEach } from 'vitest';

/*
 * 歌单卡片的封面从哪儿来。
 *
 * 这一家的歌单（收藏夹 / 投币 / 点赞 / 投稿 / 追番 / 追剧）自己没有封面图，
 * 卡片上的封面只能拿「这个歌单的第一条」那张。以前压根没赋值，
 * 界面上的表现就是「封面一直转圈 / 一片渐变」，重启也不会有。
 *
 * 这里把网络层整个换掉，只验封面这一条链路。
 */

const listeners: string[] = [];

vi.mock('../../../src/services/bilibili/transport', () => ({
    isBilibiliAvailable: () => true,
    requestBilibiliUrl: async (url: string) => {
        listeners.push(url);
        const body = (() => {
            if (url.includes('fav/folder/created/list-all')) {
                return { code: 0, data: { list: [{ id: 1, title: '\u9ed8\u8ba4\u6536\u85cf\u5939', cover: '//i0.hdslb.com/cover.png', media_count: 1 }] } };
            }
            if (url.includes('fav/resource/list')) {
                return { code: 0, data: { medias: [{ bvid: 'BV1', title: 'a', pic: '//i0.hdslb.com/pic.png', duration: 10 }], has_more: false } };
            }
            if (url.includes('x/web-interface/nav')) {
                // \u6295\u7a3f\u90a3\u4e00\u680f\u8981 wbi \u7b7e\u540d\uff0c\u628a\u94a5\u5319\u4e5f\u4e00\u5e76\u7ed9\u51fa\u3002
                return {
                    code: 0,
                    data: {
                        isLogin: true,
                        mid: 42,
                        wbi_img: {
                            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
                            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
                        },
                    },
                };
            }
            if (url.includes('space/coin/video')) {
                return { code: 0, data: { list: [{ bvid: 'BV2', title: 'b', pic: '//i1.hdslb.com/coin.png', duration: 5 }] } };
            }
            return { code: 0, data: { list: [] } };
        })();
        return { ok: true, status: 200, bodyText: JSON.stringify(body) };
    },
}));

vi.mock('../../../src/services/bilibili/api', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/bilibili/api')>(
        '../../../src/services/bilibili/api',
    );
    return { ...actual };
});

describe('\u4e2a\u4eba\u6b4c\u5355\u7684\u5c01\u9762', () => {
    beforeEach(() => { listeners.length = 0; });

    it('\u6bcf\u4e2a\u6b4c\u5355\u90fd\u5e26\u7740\u5c01\u9762\uff08\u53d6\u81ea\u5b83\u7684\u7b2c\u4e00\u6761\uff09', async () => {
        const { listBilibiliShelves } = await import('../../../src/services/bilibili/library');
        const shelves = await listBilibiliShelves();
        expect(shelves.length).toBeGreaterThan(0);
        const withCover = shelves.filter(shelf => Boolean(shelf.coverUrl));
        expect(withCover.length).toBeGreaterThan(0);
        for (const shelf of withCover) {
            expect(shelf.coverUrl?.startsWith('https://')).toBe(true);
        }
    });
});