import { describe, expect, it } from 'vitest';
import {
    bucketKeyOf,
    bucketRange,
    bucketStart,
    COMPLETED_RATIO,
    countsAsCompleted,
    countsAsPlay,
    localDayKey,
    MIN_COUNTED_SECONDS,
    normalizeAlbumName,
    normalizeArtistName,
    normalizeSongKey,
    requiredSecondsForCount,
    splitSegments,
    weekStart,
} from '../../../src/services/listeningArchive/rules';

// test/unit/listeningArchive/rules.test.ts
// 口径：本地日 / 周一起算的周 / ISO 周号、归一化键、计次阈值与跨午夜的段拆分。
// 所有时刻都按本地时间构造，测试结果与机器所在时区无关。

/**
 * 教科书上的 ISO 周号算法，只在测试里当参照物：含第一个周四的那一周算第 1 周。
 * 和 rules 里的实现对着跑，保证「周一起算 + 跨年归年」这两条没跑偏。
 */
const referenceIsoWeek = (localDayStart: Date): string => {
    const date = new Date(Date.UTC(localDayStart.getFullYear(), localDayStart.getMonth(), localDayStart.getDate()));
    const weekDay = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekDay);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/** 本地时间毫秒，写用例时只看年月日时分。 */
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number => (
    new Date(year, month - 1, day, hour, minute, second, 0).getTime()
);

describe('localDayKey', () => {
    it('用设备本地日，补零，不用 UTC', () => {
        expect(localDayKey(at(2024, 3, 5, 0, 0, 0))).toBe('2024-03-05');
        expect(localDayKey(at(2024, 3, 5, 23, 59, 59))).toBe('2024-03-05');
        expect(localDayKey(at(2024, 3, 6, 0, 0, 0))).toBe('2024-03-06');
        expect(localDayKey(at(2024, 12, 31, 12))).toBe('2024-12-31');
    });

    it('本地零点前后落在不同的日子', () => {
        const midnight = at(2024, 6, 1);
        expect(localDayKey(midnight - 1)).toBe('2024-05-31');
        expect(localDayKey(midnight)).toBe('2024-06-01');
    });
});

describe('weekStart', () => {
    it('周一到周日都回到本周一的本地零点', () => {
        // 2024-01-15 是周一。
        const monday = at(2024, 1, 15);
        expect(weekStart(at(2024, 1, 15, 0, 0, 0))).toBe(monday);
        expect(weekStart(at(2024, 1, 15, 13, 45, 30))).toBe(monday);
        expect(weekStart(at(2024, 1, 17, 8))).toBe(monday);
        expect(weekStart(at(2024, 1, 21, 23, 59, 59))).toBe(monday);
    });

    it('周日是这一周的最后一天，不算下一周的开头', () => {
        const monday = at(2024, 1, 15);
        expect(weekStart(at(2024, 1, 22))).toBe(at(2024, 1, 22));
        expect(weekStart(at(2024, 1, 22) - 1)).toBe(monday);
    });
});

describe('bucketKeyOf', () => {
    it('day / month / year', () => {
        const moment = at(2024, 3, 5, 9, 30);
        expect(bucketKeyOf(moment, 'day')).toBe('2024-03-05');
        expect(bucketKeyOf(moment, 'month')).toBe('2024-03');
        expect(bucketKeyOf(moment, 'year')).toBe('2024');
    });

    it('week 用 ISO 周号，周一起算', () => {
        expect(bucketKeyOf(at(2024, 1, 18, 10), 'week')).toBe('2024-W03');
        // 同一周的周日还是同一周。
        expect(bucketKeyOf(at(2024, 1, 21, 22), 'week')).toBe('2024-W03');
        expect(bucketKeyOf(at(2024, 1, 22, 0, 0, 1), 'week')).toBe('2024-W04');
    });

    it('week 跨年那几天归入 ISO 周所属的那一年', () => {
        // 2021-01-01 是周五，属于 2020-W53。
        expect(bucketKeyOf(at(2021, 1, 1, 12), 'week')).toBe('2020-W53');
        expect(bucketKeyOf(at(2020, 12, 31, 12), 'week')).toBe('2020-W53');
        // 2024-12-30 是周一，属于 2025-W01。
        expect(bucketKeyOf(at(2024, 12, 30, 12), 'week')).toBe('2025-W01');
        expect(bucketKeyOf(at(2025, 1, 5, 12), 'week')).toBe('2025-W01');
        expect(bucketKeyOf(at(2025, 1, 6, 12), 'week')).toBe('2025-W02');
    });

    it('week 与参照算法逐日一致（1990–2050 的每一天）', () => {
        const end = new Date(2050, 11, 31).getTime();
        const mismatches: string[] = [];
        let cursor = new Date(1990, 0, 1).getTime();
        let checked = 0;
        while (cursor <= end) {
            const day = new Date(cursor);
            const actual = bucketKeyOf(cursor, 'week');
            const expected = referenceIsoWeek(day);
            if (actual !== expected) mismatches.push(`${day.toString()}: ${actual} != ${expected}`);
            checked += 1;
            const next = new Date(cursor);
            next.setDate(next.getDate() + 1);
            next.setHours(0, 0, 0, 0);
            cursor = next.getTime();
        }
        expect(mismatches).toEqual([]);
        expect(checked).toBeGreaterThan(22000);
    });
});

describe('bucketStart', () => {
    it('各粒度的起点都是本地零点 / 本月一日 / 元旦 / 本周一', () => {
        const moment = at(2024, 3, 15, 21, 7);
        expect(bucketStart(moment, 'day')).toBe(at(2024, 3, 15));
        expect(bucketStart(moment, 'week')).toBe(at(2024, 3, 11));
        expect(bucketStart(moment, 'month')).toBe(at(2024, 3, 1));
        expect(bucketStart(moment, 'year')).toBe(at(2024, 1, 1));
    });
});

describe('bucketRange', () => {
    it('按日铺满，含没有记录的空桶', () => {
        const buckets = bucketRange(at(2024, 3, 5, 10), at(2024, 3, 7, 3), 'day');
        expect(buckets.map(bucket => bucket.key)).toEqual(['2024-03-05', '2024-03-06', '2024-03-07']);
        expect(buckets.map(bucket => bucket.start)).toEqual([at(2024, 3, 5), at(2024, 3, 6), at(2024, 3, 7)]);
    });

    it('同一桶内只出一个桶', () => {
        expect(bucketRange(at(2024, 3, 5, 1), at(2024, 3, 5, 23), 'day')).toHaveLength(1);
    });

    it('周 / 月 / 年按起始桶向外铺', () => {
        expect(bucketRange(at(2024, 1, 15), at(2024, 1, 29), 'week').map(bucket => bucket.key))
            .toEqual(['2024-W03', '2024-W04', '2024-W05']);
        expect(bucketRange(at(2024, 11, 20), at(2025, 2, 2), 'month').map(bucket => bucket.key))
            .toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
        expect(bucketRange(at(2022, 6, 1), at(2024, 2, 1), 'year').map(bucket => bucket.key))
            .toEqual(['2022', '2023', '2024']);
    });

    it('倒挂的区间与非法时刻返回空数组', () => {
        expect(bucketRange(at(2024, 3, 5), at(2024, 3, 1), 'day')).toEqual([]);
        expect(bucketRange(Number.NaN, at(2024, 3, 1), 'day')).toEqual([]);
    });
});

describe('归一化', () => {
    it('歌手名折叠空白并转小写', () => {
        expect(normalizeArtistName('  Jay   Chou ')).toBe('jay chou');
        expect(normalizeArtistName('周杰伦')).toBe('周杰伦');
        expect(normalizeArtistName('   ')).toBe('');
    });

    it('专辑名归一，取不到或归一后为空返回 null', () => {
        expect(normalizeAlbumName('  OK   Computer ')).toBe('ok computer');
        expect(normalizeAlbumName(null)).toBeNull();
        expect(normalizeAlbumName('   ')).toBeNull();
    });

    it('歌曲键忽略大小写、多余空格与歌手顺序', () => {
        const a = normalizeSongKey({ title: '  Hello   World ', artists: ['B Artist', 'A artist'] });
        const b = normalizeSongKey({ title: 'hello world', artists: ['a   ARTIST', 'b artist'] });
        expect(a).toBe(b);
        expect(a).toBe('hello world\u0001a artist,b artist');
    });

    it('歌曲键里没有歌手时歌手段留空', () => {
        expect(normalizeSongKey({ title: 'Instrumental', artists: [] })).toBe('instrumental\u0001');
        expect(normalizeSongKey({ title: 'Instrumental', artists: ['   '] })).toBe('instrumental\u0001');
    });
});

describe('计次口径', () => {
    it('门槛是 min(30 秒, 时长的一半)', () => {
        expect(MIN_COUNTED_SECONDS).toBe(30);
        expect(requiredSecondsForCount(0)).toBe(30);
        expect(requiredSecondsForCount(-5)).toBe(30);
        expect(requiredSecondsForCount(Number.NaN)).toBe(30);
        expect(requiredSecondsForCount(40)).toBe(20);
        expect(requiredSecondsForCount(60)).toBe(30);
        expect(requiredSecondsForCount(600)).toBe(30);
    });

    it('够门槛才计一次', () => {
        expect(countsAsPlay(29.9, 0)).toBe(false);
        expect(countsAsPlay(30, 0)).toBe(true);
        expect(countsAsPlay(19.9, 40)).toBe(false);
        expect(countsAsPlay(20, 40)).toBe(true);
        expect(countsAsPlay(Number.NaN, 0)).toBe(false);
    });

    it('听满 90% 算整首，时长未知一律不算', () => {
        expect(COMPLETED_RATIO).toBe(0.9);
        expect(countsAsCompleted(89, 100)).toBe(false);
        expect(countsAsCompleted(90, 100)).toBe(true);
        expect(countsAsCompleted(45, 50)).toBe(true);
        expect(countsAsCompleted(30, 0)).toBe(false);
        expect(countsAsCompleted(30, -1)).toBe(false);
    });
});

describe('splitSegments', () => {
    it('同一天内只有一段，秒数原样', () => {
        const segments = splitSegments(at(2024, 3, 5, 8), at(2024, 3, 5, 9), 120);
        expect(segments).toEqual([{ day: '2024-03-05', seconds: 120, startedAt: at(2024, 3, 5, 8) }]);
    });

    it('跨午夜拆成两天，秒数按时间占比分配', () => {
        // 23:00 听到次日 01:00，共两小时：前一天 1 小时，后一天 1 小时。
        const start = at(2024, 3, 5, 23);
        const end = at(2024, 3, 6, 1);
        const segments = splitSegments(start, end, 600);
        expect(segments).toEqual([
            { day: '2024-03-05', seconds: 300, startedAt: start },
            { day: '2024-03-06', seconds: 300, startedAt: at(2024, 3, 6) },
        ]);
        expect(segments.reduce((sum, segment) => sum + segment.seconds, 0)).toBe(600);
    });

    it('跨了 n 天就出 n 段，总和恒等于 listenedSeconds', () => {
        const start = at(2024, 3, 5, 20);
        const end = at(2024, 3, 8, 2);
        const segments = splitSegments(start, end, 100);
        expect(segments.map(segment => segment.day)).toEqual(['2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08']);
        expect(segments.reduce((sum, segment) => sum + segment.seconds, 0)).toBe(100);
        // 舍入误差全部由末段吸收，前面各段向下取整。
        segments.slice(0, -1).forEach(segment => expect(Number.isInteger(segment.seconds)).toBe(true));
        segments.forEach(segment => expect(segment.seconds).toBeGreaterThanOrEqual(0));
    });

    it('只听到午夜前一点点，末段可以是 0 秒', () => {
        const start = at(2024, 3, 5, 23, 59, 59);
        const end = at(2024, 3, 6, 0, 0, 1);
        const segments = splitSegments(start, end, 1);
        expect(segments).toHaveLength(2);
        expect(segments.reduce((sum, segment) => sum + segment.seconds, 0)).toBe(1);
    });

    it('开始与结束同刻、或者数据倒挂时也给一段', () => {
        expect(splitSegments(at(2024, 3, 5, 8), at(2024, 3, 5, 8), 0)).toEqual([
            { day: '2024-03-05', seconds: 0, startedAt: at(2024, 3, 5, 8) },
        ]);
        expect(splitSegments(at(2024, 3, 5, 8), at(2024, 3, 5, 7), 10)).toEqual([
            { day: '2024-03-05', seconds: 10, startedAt: at(2024, 3, 5, 8) },
        ]);
    });

    it('负的或非有限的秒数按 0 处理', () => {
        expect(splitSegments(at(2024, 3, 5, 8), at(2024, 3, 5, 9), -3)[0].seconds).toBe(0);
        expect(splitSegments(at(2024, 3, 5, 8), at(2024, 3, 5, 9), Number.NaN)[0].seconds).toBe(0);
    });
});
