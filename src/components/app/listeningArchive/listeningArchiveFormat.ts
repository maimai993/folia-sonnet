import type { ArchiveRangePreset } from './listeningArchiveStore';
import { formatLocalDateStamp } from '../../../utils/downloadFileName';

// src/components/app/listeningArchive/listeningArchiveFormat.ts
// 听歌档案界面用的几个格式化：时间范围档位换算成时刻、秒数写成「x 小时 y 分」、日期与时刻。
// 纯函数，没有 React：图表、排行、单曲轨迹共用同一份口径。

/** 界面上的时间范围档位，按从短到长排。 */
export const RANGE_PRESETS: readonly ArchiveRangePreset[] = ['week', 'month', 'quarter', 'year', 'all'];

/** 每个档位往前看多少天；`null` = 全部。 */
const RANGE_DAYS: Record<ArchiveRangePreset, number | null> = {
    week: 7,
    month: 30,
    quarter: 90,
    year: 365,
    all: null,
};

/**
 * 这个档位的起点（本地零点，毫秒）。
 *
 * 「最近 7 天」包含今天，所以往前推到 7 天前的零点而不是现在减去 7×24 小时 —— 否则今天
 * 早上听的那半小时会被算到范围外。`all` 返回 0：聚合那边把 0 当成「有记录以来」。
 */
export const rangeStartOf = (preset: ArchiveRangePreset, now: number = Date.now()): number => {
    const days = RANGE_DAYS[preset];
    if (days === null) return 0;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    return start.getTime();
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 秒数写成「x 小时 y 分」。
 *
 * 满一小时才写小时，一分钟以下才写秒：排行里一眼要的是量级，写成 `18 小时 42 分` 已经足够，
 * 精确到秒只会在窄屏上把一行的右边挤掉。
 */
export const formatArchiveDuration = (t: Translate, seconds: number): string => {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
    if (total < 60) return t('listeningArchive.duration.seconds', { seconds: total });
    if (total < 3600) return t('listeningArchive.duration.minutes', { minutes: Math.floor(total / 60) });
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return t('listeningArchive.duration.hoursMinutes', { hours, minutes });
};

/** 时刻（毫秒）写成设备本地的 `YYYY-MM-DD`；与数据层分日用的是同一套本地日历口径。 */
export const formatArchiveDate = (at: number): string => (
    Number.isFinite(at) && at > 0 ? formatLocalDateStamp(new Date(at)) : ''
);

/** 时刻（毫秒）写成设备本地的 `HH:MM`。 */
export const formatArchiveClock = (at: number): string => {
    if (!Number.isFinite(at) || at <= 0) return '';
    const date = new Date(at);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/** 桶键在图表下方当刻度用；太长就只留后一段（`2024-05-06` → `05-06`）。 */
export const shortBucketLabel = (key: string): string => {
    if (key.length <= 7) return key;
    const tail = key.slice(-5);
    return tail;
};
