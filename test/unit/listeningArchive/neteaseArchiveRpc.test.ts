import { beforeEach, describe, expect, it } from 'vitest';
import { neteaseArchiveRpc } from '../../../src/services/onlineMusic/netease/neteaseArchiveRpc';

// test/unit/listeningArchive/neteaseArchiveRpc.test.ts
// 听歌档案模组里网易云云端那一组 rpc（netease.state / invalidate / configure / account / rank / report）
// 在安卓端的回答：没登录时不记账、接口给的失败只记原因不丢上一期、拿到报告时认字段算时长。
// 取数由模组自己经 platform.raw 做，所以这里没有网络，全部是「它交给我们什么、我们回它什么」。

interface Field {
    path: string;
    value: number;
}

interface Report {
    accountKey: string;
    metric: string;
    syncedAt: number;
    fields: Field[];
    seconds: number | null;
    error?: string;
    periodStart?: number;
    periodEnd?: number;
}

interface State {
    config: { endpoint: string; accountKey: string; mappings: Record<string, { path: string; unit: string }> };
    loggedIn: boolean;
    nickname: string;
    ranks: Record<string, { accountKey: string; scope: string; syncedAt: number; songs: Array<Record<string, unknown>> }>;
    reports: Record<string, Report>;
}

const call = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const handler = neteaseArchiveRpc[name];
    if (!handler) throw new Error(`no handler: ${name}`);
    return await handler(args) as T;
};

const ACCOUNT = { accountKey: '123456789', nickname: '听歌的人' };

/** 一份「本周」报告：网易云把它放在 listenTimeDistributionBlock.playDuration，单位是分钟。 */
const weekReport = (minutes: number, extra: Record<string, unknown> = {}) => ({
    code: 200,
    data: {
        type: 'week',
        startTime: 1_700_000_000_000,
        endTime: 1_700_600_000_000,
        listenTimeDistributionBlock: { blockType: 'LISTEN_TIME_DISTRIBUTION_WEEK', playDuration: minutes },
        ...extra,
    },
});

/** 一份能用的排行榜回答（weekData）。 */
const weekRank = () => ({
    code: 200,
    weekData: [
        {
            playCount: 12,
            song: {
                id: 1901371647,
                name: '海阔天空',
                ar: [{ id: 1, name: 'Beyond' }, { id: 2, name: '群星' }],
                al: { id: 33, name: '乐与怒', picUrl: 'http://p1.music.126.net/cover.jpg' },
            },
        },
        {
            playCount: 3,
            song: { id: 2, name: '第二名', artists: [{ name: '某人' }], album: { name: '专辑' } },
        },
    ],
});

beforeEach(async () => {
    // 状态在模块里留一份：每个用例从头开始。
    await call('netease.invalidate');
});

describe('登录态', () => {
    it('还没记下账号时，排行与报告都不接，回一句先去登录', async () => {
        await expect(call('netease.rank', ACCOUNT.accountKey, 'week', weekRank()))
            .rejects.toThrow('还没登录网易云');
        await expect(call('netease.report', ACCOUNT.accountKey, 'total', { code: 200, data: { totalDuration: 10 } }, null))
            .rejects.toThrow('还没登录网易云');
    });

    it('账号对不上时不记账，说明要重新同步', async () => {
        await call('netease.account', ACCOUNT);
        await expect(call('netease.rank', 'someone-else', 'week', weekRank()))
            .rejects.toThrow('账号或范围已更改，请重新同步');
        await expect(call('netease.report', 'someone-else', 'total', { code: 200, data: { totalDuration: 1 } }, null))
            .rejects.toThrow('账号或范围已更改，请重新同步');
        expect((await call<State>('netease.state')).reports).toEqual({});
    });

    it('交一个空的账号就是退出：状态回到空，登录态置 false', async () => {
        await call('netease.account', ACCOUNT);
        expect((await call<State>('netease.state')).loggedIn).toBe(true);

        const cleared = await call<State>('netease.account', null);
        expect(cleared.loggedIn).toBe(false);
        expect(cleared.config.accountKey).toBe('');
        expect(cleared.nickname).toBe('');
    });

    it('账号信息不合法时抛中文原因', async () => {
        await expect(call('netease.account', { accountKey: '', nickname: 'x' })).rejects.toThrow('账号信息无效');
        await expect(call('netease.account', { accountKey: 'a'.repeat(257), nickname: 'x' })).rejects.toThrow('账号信息无效');
        await expect(call('netease.account', { accountKey: '1', nickname: 42 })).rejects.toThrow('账号信息无效');
    });
});

describe('接口失败', () => {
    it('报告没拿到时只记原因，上一期的字段与秒数留着', async () => {
        await call('netease.account', ACCOUNT);
        const first = await call<State>('netease.report', ACCOUNT.accountKey, 'week', weekReport(30), null);
        expect(first.reports.week.seconds).toBe(1800);

        const failed = await call<State>('netease.report', ACCOUNT.accountKey, 'week', null, '无法连接网易云，请稍后重试');
        expect(failed.reports.week.error).toBe('无法连接网易云，请稍后重试');
        expect(failed.reports.week.seconds).toBe(1800);
        expect(failed.reports.week.fields.length).toBe(first.reports.week.fields.length);
    });

    it('报告没拿到且本来没有上一期时，只留一条原因', async () => {
        await call('netease.account', ACCOUNT);
        const state = await call<State>('netease.report', ACCOUNT.accountKey, 'month', null, '需要会员权限');
        expect(state.reports.month).toMatchObject({ metric: 'month', syncedAt: 0, fields: [], seconds: null, error: '需要会员权限' });
    });

    it('排行榜回答不可用时抛中文原因，不动已有数据', async () => {
        await call('netease.account', ACCOUNT);
        await expect(call('netease.rank', ACCOUNT.accountKey, 'week', { code: 301 }))
            .rejects.toThrow('排行榜不可用：请检查登录状态、用户 ID 和隐私权限');
        await expect(call('netease.rank', ACCOUNT.accountKey, 'all', { code: 200, allData: 'oops' }))
            .rejects.toThrow('排行榜返回结构变化，保留上次结果');
        await expect(call('netease.rank', ACCOUNT.accountKey, 'week', { code: 200, weekData: [{ playCount: 1, song: { id: 'x', name: 'y' } }] }))
            .rejects.toThrow('排行榜条目无效，保留上次结果');
        expect((await call<State>('netease.state')).ranks).toEqual({});
    });

    it('平台没给报告数据时抛中文原因', async () => {
        await call('netease.account', ACCOUNT);
        await expect(call('netease.report', ACCOUNT.accountKey, 'total', { code: 500 }, null))
            .rejects.toThrow('平台未提供报告，可能需要登录或会员权限');
        await expect(call('netease.report', ACCOUNT.accountKey, 'total', { code: 200 }, null))
            .rejects.toThrow('平台未提供报告，可能需要登录或会员权限');
    });
});

describe('正常返回', () => {
    it('记下账号，报告认字段、算成秒，并把周期带回来', async () => {
        const state = await call<State>('netease.account', ACCOUNT);
        expect(state).toMatchObject({ loggedIn: true, nickname: '听歌的人' });
        expect(state.config.accountKey).toBe(ACCOUNT.accountKey);

        const after = await call<State>('netease.report', ACCOUNT.accountKey, 'week', weekReport(30), null);
        expect(after.reports.week.seconds).toBe(1800);
        expect(after.reports.week.periodStart).toBe(1_700_000_000_000);
        expect(after.reports.week.periodEnd).toBe(1_700_600_000_000);
        expect(after.reports.week.fields.map((field) => field.path))
            .toEqual(expect.arrayContaining(['data.listenTimeDistributionBlock.playDuration']));
        // 认出来的字段自动变成映射，界面下次就能直接显示秒数。
        expect(after.config.mappings.week).toEqual({ path: 'data.listenTimeDistributionBlock.playDuration', unit: 'minutes' });
    });

    it('全部的听歌时长走 data.totalDuration，单位是秒', async () => {
        await call('netease.account', ACCOUNT);
        const state = await call<State>('netease.report', ACCOUNT.accountKey, 'total', { code: 200, data: { totalDuration: 93_000 } }, null);
        expect(state.reports.total.seconds).toBe(93_000);
        expect(state.reports.total.periodStart).toBeUndefined();
    });

    it('报告里的凭据字段与字符串不进拍平结果', async () => {
        await call('netease.account', ACCOUNT);
        const state = await call<State>('netease.report', ACCOUNT.accountKey, 'total', {
            code: 200,
            data: { totalDuration: 5, cookie: 'MUSIC_U=secret', session: { token: 'x' }, note: '一句话' },
        }, null);
        const paths = state.reports.total.fields.map((field) => field.path);
        expect(paths).toEqual(['data.totalDuration']);
    });

    it('排行榜收成界面要的那几项，封面只认网易云的域名并升成 https', async () => {
        await call('netease.account', ACCOUNT);
        const state = await call<State>('netease.rank', ACCOUNT.accountKey, 'week', weekRank());
        const rank = state.ranks.week;
        expect(rank.scope).toBe('week');
        expect(rank.accountKey).toBe(ACCOUNT.accountKey);
        expect(rank.songs).toHaveLength(2);
        expect(rank.songs[0]).toMatchObject({
            id: '1901371647',
            name: '海阔天空',
            artists: 'Beyond / 群星',
            album: '乐与怒',
            albumId: '33',
            plays: 12,
            cover: 'https://p1.music.126.net/cover.jpg',
        });
        // 第二名没有封面：不是 music.126.net 的地址一律不放。
        expect(rank.songs[1].cover).toBeNull();
        expect(rank.songs[1].artists).toBe('某人');
    });

    it('configure 换单位后秒数重算；字段不在报告里时抛中文原因', async () => {
        await call('netease.account', ACCOUNT);
        await call('netease.report', ACCOUNT.accountKey, 'week', weekReport(30), null);

        const state = await call<State>('netease.configure', {
            accountKey: ACCOUNT.accountKey,
            mappings: { week: { path: 'data.listenTimeDistributionBlock.playDuration', unit: 'seconds' } },
        });
        expect(state.reports.week.seconds).toBe(30);
        expect(state.config.mappings.week.unit).toBe('seconds');

        await expect(call('netease.configure', {
            accountKey: ACCOUNT.accountKey,
            mappings: { week: { path: 'data.没有这个字段', unit: 'seconds' } },
        })).rejects.toThrow('请选择实际返回的听歌时长字段，并明确确认单位');

        await expect(call('netease.configure', {
            accountKey: 'someone-else',
            mappings: { week: { path: 'data.listenTimeDistributionBlock.playDuration', unit: 'seconds' } },
        })).rejects.toThrow('账号已更改，请重新确认报告字段');
    });

    it('换账号时上一号的报告、排行与映射都丢掉', async () => {
        await call('netease.account', ACCOUNT);
        await call('netease.report', ACCOUNT.accountKey, 'week', weekReport(30), null);
        await call('netease.rank', ACCOUNT.accountKey, 'week', weekRank());

        const state = await call<State>('netease.account', { accountKey: '999', nickname: '另一个人' });
        expect(state.reports).toEqual({});
        expect(state.ranks).toEqual({});
        expect(state.config.mappings).toEqual({});
        expect(state.config.accountKey).toBe('999');
    });

    it('invalidate 之后状态回到空', async () => {
        await call('netease.account', ACCOUNT);
        const state = await call<State>('netease.invalidate');
        expect(state).toEqual({
            config: { endpoint: 'Folium platform.raw', accountKey: '', mappings: {} },
            loggedIn: false,
            nickname: '',
            ranks: {},
            reports: {},
        });
    });
});
