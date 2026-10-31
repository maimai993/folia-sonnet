import { describe, expect, it } from 'vitest';
import {
    isSongTitleCandidate,
    looseSongTitle,
    rankSongTitleMatch,
    songTitleFallbackTokens,
    songTitleKey,
    songTitleQueryTokens,
    songTitleTokens,
} from '../../../sync-server/src/songTitleMatch';

// test/unit/sync-server/songTitleMatch.test.ts
// 「同一首歌」在各平台上的名字并不一致，精确键没命中时能不能靠歌名捞到那条缓存，
// 全看这里压得对不对。
//
// 判「合不合规」仍然是客户端拿高亮词一条一条对（highlightWordsPresent）—— 这里放宽
// 的是**候选的入口**，不是判定：多给几条没关系，给错了也还有那一层兜着。

describe('songTitleKey —— 压成核心名', () => {
    it('削掉括号里的备注', () => {
        expect(songTitleKey('晴天 (Live)')).toBe(songTitleKey('晴天'));
        expect(songTitleKey('晴天（Live）')).toBe(songTitleKey('晴天'));
        expect(songTitleKey('晴天【伴奏】')).toBe(songTitleKey('晴天'));
        expect(songTitleKey('晴天[Live]')).toBe(songTitleKey('晴天'));
    });

    it('削掉后缀', () => {
        expect(songTitleKey('稻香 Remix')).toBe(songTitleKey('稻香'));
        expect(songTitleKey('稻香 现场版')).toBe(songTitleKey('稻香'));
        expect(songTitleKey('稻香 (钢琴版)')).toBe(songTitleKey('稻香'));
        expect(songTitleKey('稻香 feat. 某人')).toBe(songTitleKey('稻香'));
        expect(songTitleKey('稻香 Acoustic')).toBe(songTitleKey('稻香'));
    });

    it('后缀叠着写也削得掉', () => {
        expect(songTitleKey('稻香 Live Ver.')).toBe(songTitleKey('稻香'));
    });

    it('压掉标点、空格与大小写', () => {
        expect(songTitleKey('Someone Like You')).toBe(songTitleKey('someonelikeyou'));
        expect(songTitleKey('Someone Like You (Live)')).toBe(songTitleKey('Someone Like You'));
        expect(songTitleKey('七里香 ')).toBe(songTitleKey('七里香'));
    });

    /*
     * 「请求更长」那一种以前永远配不上：库里存的是「晴天」，手上这首叫「晴天 (Live)」。
     * 光靠 SQL 的 LIKE '%晴天 (Live)%' 是配不到「晴天」的 —— 得先把请求压短。
     */
    it('把请求那一侧也压短，才配得上库里的短名', () => {
        expect(songTitleKey('晴天 (Live)')).toBe('晴天');
    });
});

describe('looseSongTitle —— 拿去问数据库的那个名字', () => {
    /*
     * 压掉空格就配不上库里原样的「Someone Like You」了 —— SQL 的 LIKE 要比的是
     * 库里那条字符串，所以这一层必须留着空格。
     */
    it('保留空格与标点', () => {
        expect(looseSongTitle('Someone Like You (Live)')).toBe('Someone Like You');
        expect(looseSongTitle('晴天 (Live)')).toBe('晴天');
    });

    it('空输入不会变成 undefined', () => {
        expect(looseSongTitle('')).toBe('');
        expect(songTitleKey('')).toBe('');
    });
});

describe('rankSongTitleMatch —— 谁该排前面', () => {
    it('归一后完全一样最优先', () => {
        expect(rankSongTitleMatch('晴天 (Live)', '晴天')).toBe(0);
        expect(rankSongTitleMatch('晴天', '晴天 (Live)')).toBe(0);
    });

    it('一边更长就算包含', () => {
        expect(rankSongTitleMatch('晴天 电影主题曲', '晴天')).toBe(1);
        expect(rankSongTitleMatch('晴天', '晴天 电影主题曲')).toBe(2);
    });

    /* 「现场」「Live」这些是噪声，削完之后两边应当完全相等，而不是落进「包含」。 */
    it('削掉噪声后落回完全相等', () => {
        expect(rankSongTitleMatch('晴天 现场', '晴天')).toBe(0);
        expect(rankSongTitleMatch('晴天 (Live)', '晴天')).toBe(0);
    });

    it('归一后对不上就不算候选', () => {
        expect(rankSongTitleMatch('七里香', '晴天')).toBe(3);
        expect(isSongTitleCandidate('七里香', '晴天')).toBe(false);
    });

    /*
     * 歌名整个就是噪声（就叫「Live」）时压不出核心名 —— 拿它做模糊匹配会把半个库
     * 都捞回来，宁可一条不给。
     */
    it('压不出核心名的不算候选', () => {
        expect(songTitleKey('Live')).toBe('');
        expect(isSongTitleCandidate('晴天', 'Live')).toBe(false);
        expect(isSongTitleCandidate('', '晴天')).toBe(false);
    });

    it('同分时新的排在前面由调用方按 updated_at 定，这里只保证同分', () => {
        expect(rankSongTitleMatch('晴天 (Live)', '晴天（现场版）')).toBe(0);
    });
});

/*
 * 倒排索引的 token。写进去的和查询时问的必须是同一套 —— 两边不一致就会
 * 「明明在库里，却怎么也捞不到」，而且不会报错，只会静默返回空候选。
 */
describe('songTitleTokens —— 倒排索引写什么、问什么', () => {
    it('核心名一定带 K: 前缀', () => {
        expect(songTitleTokens('晴天')).toContain('K:晴天');
        expect(songTitleQueryTokens('晴天')).toContain('K:晴天');
    });

    /* 括号、后缀、大小写压完之后是同一个核心名，所以指向同一批候选。 */
    it('同一首歌的不同写法落到同一个 K: token', () => {
        for (const variant of ['晴天 (Live)', '晴天【伴奏】', '晴天 现场版', '晴天 Remix']) {
            expect(songTitleTokens(variant)).toContain('K:晴天');
        }
        expect(songTitleTokens('Someone Like You (Live)')).toContain('K:someonelikeyou');
    });

    /* 「周杰伦 - 晴天」要能配上库里的「晴天」：靠 S: 拆段。 */
    it('「歌手 - 歌名」拆段后各有一个 S: token', () => {
        const tokens = songTitleTokens('周杰伦 - 晴天');
        expect(tokens).toContain('S:周杰伦');
        expect(tokens).toContain('S:晴天');
    });

    /*
     * 不建单字 token：中文常用字太泛（实测 4 万条库里 `C:海` 命中 5022 行），
     * 拿它查会把 LIMIT 一次撑满，等于换个方式全扫。
     */
    it('不建单字 token', () => {
        expect(songTitleTokens('晴天')).toEqual(['K:晴天', 'S:晴天', 'D:晴']);
        expect(songTitleTokens('Someone Like You').some((token) => token.startsWith('C:'))).toBe(false);
        expect(songTitleQueryTokens('晴天雨天雪天').some((token) => token.startsWith('C:'))).toBe(false);
    });

    it('首字/首词钩子有 D: token，且统一小写', () => {
        /* 中日韩取首字，拉丁取首词（至少三个字符，见 songTitleSeed）。 */
        expect(songTitleTokens('晴天')).toContain('D:晴');
        expect(songTitleTokens('Someone Like You')).toContain('D:someone');
        /* token 是逐字相等才命中的，大小写不统一就会静默配不上。 */
        expect(songTitleTokens('Someone Like You').filter((token) => token.startsWith('D:')))
            .toEqual(songTitleTokens('someone like you').filter((token) => token.startsWith('D:')));
    });

    /*
     * 写路径与读路径的对应关系由下面「精确 token 与兜底 token 分开，合并起来就是完整一套」
     * 那条钉住：读侧分成两轮问，两轮合起来必须等于写进去的那一套。
     */

    /*
     * 两轮查询：第一轮只问精确的 K:/S:，D: 留到一条都没命中时单独问。
     * 混在一条 IN (...) 里 D: 会把 LIMIT 撑满，把精确命中挤掉。
     */
    it('精确 token 与兜底 token 分开，合并起来就是完整一套', () => {
        for (const title of ['晴天', '周杰伦 - 晴天', 'Someone Like You']) {
            const precise = songTitleQueryTokens(title);
            const fallback = songTitleFallbackTokens(title);
            expect(precise.every((token) => !token.startsWith('D:'))).toBe(true);
            expect(fallback.every((token) => token.startsWith('D:'))).toBe(true);
            /* 两轮合起来必须等于写进索引的那一套，否则会有 token 永远问不到。 */
            expect([...precise, ...fallback].sort()).toEqual([...songTitleTokens(title)].sort());
        }
    });

    /* 压不出核心名的（整个名字都是噪声）不该进索引，也不该去问。 */
    it('压不出核心名时两边都是空', () => {
        expect(songTitleTokens('Live')).toEqual([]);
        expect(songTitleQueryTokens('Live')).toEqual([]);
        expect(songTitleFallbackTokens('Live')).toEqual([]);
        expect(songTitleTokens('')).toEqual([]);
    });

    it('token 不重复', () => {
        const tokens = songTitleTokens('晴天 晴天 (Live)');
        expect(new Set(tokens).size).toBe(tokens.length);
    });
});
