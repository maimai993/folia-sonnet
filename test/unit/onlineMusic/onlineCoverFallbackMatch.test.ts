import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/onlineCoverFallbackMatch.test.ts
// #324：按歌名借封面时，只借歌名一致、歌手对得上的那一条；对不上宁可空着。

type Item = { name: string; artists: Array<{ name: string }>; album: { coverUrl: string } };
const state = vi.hoisted(() => ({ results: new Map<string, Item[]>(), queries: [] as string[] }));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        searchProviderSongs: vi.fn(async (providerId: string, query: string) => {
            state.queries.push(`${providerId}:${query}`);
            return { items: state.results.get(`${providerId}:${query}`) ?? [] };
        }),
    },
}));
vi.mock('@/services/localCoverReadyEvent', () => ({ announceLocalCoverReady: vi.fn() }));

const item = (name: string, artist: string, coverUrl: string): Item => ({
    name, artists: [{ name: artist }], album: { coverUrl },
});

const load = async () => (await import('@/services/onlineMusic/onlineCoverFallback')).searchCoverBySongName;

describe('cover fallback match', () => {
    beforeEach(() => {
        vi.resetModules();
        state.results.clear();
        state.queries = [];
    });

    it('skips a same-titled song by another artist', async () => {
        state.results.set('netease:晴天 歌手X', [
            item('晴天', '周杰伦', 'https://cover.test/jay.jpg'),
            item('晴天 (Live)', '歌手X', 'https://cover.test/x.jpg'),
        ]);
        expect(await (await load())('晴天', '歌手X')).toBe('https://cover.test/x.jpg');
    });

    it('returns nothing rather than the first unrelated result', async () => {
        state.results.set('netease:雨', [item('雨夜的告白', '某人', 'https://cover.test/wrong.jpg')]);
        state.results.set('qq:雨', [item('Rain', '某人', 'https://cover.test/wrong2.jpg')]);
        expect(await (await load())('雨', '')).toBe('');
    });

    it('matches any one of several credited artists', async () => {
        state.results.set('netease:Song A/B', [
            { name: 'Song', artists: [{ name: 'C' }, { name: 'b' }], album: { coverUrl: 'https://cover.test/ok.jpg' } },
        ]);
        expect(await (await load())('Song', 'A/B')).toBe('https://cover.test/ok.jpg');
    });

    it('matches traditional and simplified spellings of the same artist', async () => {
        state.results.set('netease:晴天 周杰倫', [item('晴天', '周杰伦', 'https://cover.test/jay.jpg')]);
        expect(await (await load())('晴天', '周杰倫')).toBe('https://cover.test/jay.jpg');
    });

    it('compares a title made only of brackets by the whole title', async () => {
        // 书名号不是版本后缀：`《晴天》` 就是《晴天》，不会被剥成空串而永远失配。
        state.results.set('netease:《晴天》', [item('晴天', '某人', 'https://cover.test/plain.jpg')]);
        expect(await (await load())('《晴天》', '')).toBe('https://cover.test/plain.jpg');
        state.results.set('netease:(Untitled)', [item('(Untitled)', 'A', 'https://cover.test/untitled.jpg')]);
        expect(await (await load())('(Untitled)', '')).toBe('https://cover.test/untitled.jpg');
    });

    it('skips the title-only search on a platform that only offered other artists\' versions', async () => {
        state.results.set('netease:晴天 歌手X', [item('晴天', '周杰伦', 'https://cover.test/jay.jpg')]);
        expect(await (await load())('晴天', '歌手X')).toBe('');
        expect(state.queries).not.toContain('netease:晴天');
        expect(state.queries).toContain('qq:晴天');
    });

    it('falls back to a title-only search when the artist search finds nothing', async () => {
        state.results.set('kugou:Track', [item('Track', 'Artist', 'https://cover.test/track.jpg')]);
        expect(await (await load())('Track', 'Artist')).toBe('https://cover.test/track.jpg');
        expect(state.queries[0]).toBe('netease:Track Artist');
    });
});
