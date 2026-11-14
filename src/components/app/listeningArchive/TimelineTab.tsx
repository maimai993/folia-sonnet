import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { ArchiveGranularity, ArchivePlay } from '../../../services/listeningArchive/types';
import { heatCells, timelineBuckets, totals } from '../../../services/listeningArchive/aggregate';
import { Segmented } from '@/components/modal/settings/kit';
import { useListeningArchiveSettingsStore } from '../../../stores/useListeningArchiveSettingsStore';
import { useListeningArchiveStore } from './listeningArchiveStore';
import {
    formatArchiveDuration,
    rangeStartOf,
    shortBucketLabel,
} from './listeningArchiveFormat';
import ArchiveLineChart, { type ArchiveChartTick } from './ArchiveLineChart';
import ArchiveHeatmap from './ArchiveHeatmap';
import ArchiveBucketDialog from './ArchiveBucketDialog';

// src/components/app/listeningArchive/TimelineTab.tsx
// 时长页：日 / 周 / 月 / 年四个粒度看累计时长的折线，再加上「一周里哪几个小时在听」的声浪热力。
//
// 折线画的是累计值（aggregate 给的是每桶的量，这里自己做一次前缀和）：累计曲线不会因为某一天
// 听了三个小时就把其余日子压成一条平线。点折线上的某一段会展开那一段的记录。
//
// 粒度和范围都从功能 store 来，排行页与时长页共用同一个范围档位 —— 两页看到的必须是同一段时间。

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** 横轴刻度每多少小时一个。 */
const HOUR_TICK_STEP = 6;
/** 折线下方最多标几个刻度。 */
const MAX_TICKS = 6;

type TimelineTabProps = {
    plays: ArchivePlay[];
    isDaylight: boolean;
};

const TimelineTab: React.FC<TimelineTabProps> = ({ plays, isDaylight }) => {
    const { t } = useTranslation();
    const {
        range,
        granularity,
        focusedBucketKey,
        setGranularity,
        setFocusedBucketKey,
    } = useListeningArchiveStore(useShallow(state => ({
        range: state.range,
        granularity: state.granularity,
        focusedBucketKey: state.focusedBucketKey,
        setGranularity: state.setGranularity,
        setFocusedBucketKey: state.setFocusedBucketKey,
    })));

    const lowPerformance = useListeningArchiveSettingsStore(state => state.lowPerformance);
    // 「现在」在开页那一刻定一次：每帧都重新取会让下面几张图每次都重算。
    const [now] = useState(() => Date.now());
    const rangeStart = rangeStartOf(range, now);
    /**
     * 范围的起点。「全部」档位给的是 0，按 1970 铺日桶会有两万个格子：起点改成最早那次播放，
     * 一次记录都没有时退回最近 30 天，图表至少还铺得出一段能看的时间。
     */
    const from = useMemo(() => {
        if (rangeStart > 0) return rangeStart;
        const earliest = plays.reduce(
            (first, play) => (play.startedAt < first ? play.startedAt : first),
            Number.POSITIVE_INFINITY,
        );
        return Number.isFinite(earliest) ? earliest : now - 30 * 24 * 60 * 60 * 1000;
    }, [now, plays, rangeStart]);

    const inRange = useMemo(
        () => plays.filter(play => play.endedAt >= from),
        [from, plays],
    );
    const summary = useMemo(() => totals(inRange), [inRange]);
    const buckets = useMemo(
        () => timelineBuckets(plays, granularity, from, now),
        [from, granularity, now, plays],
    );
    const cumulative = useMemo(() => {
        let sum = 0;
        return buckets.map((bucket) => {
            sum += bucket.seconds;
            return sum;
        });
    }, [buckets]);
    const ticks = useMemo<ArchiveChartTick[]>(() => {
        if (buckets.length === 0) return [];
        const step = Math.max(1, Math.ceil(buckets.length / MAX_TICKS));
        const picked: ArchiveChartTick[] = [];
        for (let index = 0; index < buckets.length; index += step) {
            picked.push({
                text: shortBucketLabel(buckets[index].key),
                position: buckets.length === 1 ? 0.5 : index / (buckets.length - 1),
            });
        }
        return picked;
    }, [buckets]);
    const cells = useMemo(() => heatCells(plays, from, now), [from, now, plays]);

    const granularityOptions = useMemo<Array<{ value: ArchiveGranularity; label: string }>>(() => ([
        { value: 'day', label: t('listeningArchive.timeline.granularities.day') },
        { value: 'week', label: t('listeningArchive.timeline.granularities.week') },
        { value: 'month', label: t('listeningArchive.timeline.granularities.month') },
        { value: 'year', label: t('listeningArchive.timeline.granularities.year') },
    ]), [t]);
    const weekdayLabels = useMemo(
        () => WEEKDAY_KEYS.map(key => t(`listeningArchive.timeline.weekdays.${key}`)),
        [t],
    );
    const hourTicks = useMemo(
        () => Array.from({ length: Math.ceil(24 / HOUR_TICK_STEP) }, (_, index) => index * HOUR_TICK_STEP),
        [],
    );

    const focusedBucket = useMemo(
        () => (focusedBucketKey ? buckets.find(bucket => bucket.key === focusedBucketKey) ?? null : null),
        [buckets, focusedBucketKey],
    );
    const animate = !lowPerformance;

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center gap-2">
                <Segmented value={granularity} options={granularityOptions} onChange={setGranularity} />
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--st-t2)]">
                    <span>{formatArchiveDuration(t, summary.seconds)}</span>
                    <span>{t('listeningArchive.playsCount', { count: summary.plays })}</span>
                    <span>{t('listeningArchive.timeline.songCount', { count: summary.songs })}</span>
                </p>
            </div>

            <section>
                <h3 className="mb-1 text-[12px] text-[color:var(--st-t2)]">
                    {t('listeningArchive.timeline.cumulativeTitle')}
                </h3>
                <ArchiveLineChart
                    values={cumulative}
                    ticks={ticks}
                    animate={animate}
                    emptyLabel={t('listeningArchive.timeline.empty')}
                    onSelect={index => setFocusedBucketKey(buckets[index]?.key ?? null)}
                    segmentLabel={index => {
                        const bucket = buckets[index];
                        return bucket
                            ? `${bucket.key} · ${formatArchiveDuration(t, bucket.seconds)}`
                            : '';
                    }}
                />
            </section>

            <section>
                <h3 className="mb-1 text-[12px] text-[color:var(--st-t2)]">
                    {t('listeningArchive.timeline.heatmapTitle')}
                </h3>
                <ArchiveHeatmap
                    cells={cells}
                    weekdayLabels={weekdayLabels}
                    hourTicks={hourTicks}
                    animate={animate}
                    cellLabel={(cell) => t('listeningArchive.timeline.heatmapCellLabel', {
                        weekday: weekdayLabels[cell.weekday],
                        hour: cell.hour,
                        duration: formatArchiveDuration(t, cell.seconds),
                    })}
                />
                <p className="mt-1 text-[10px] text-[color:var(--st-t3)]">
                    {t('listeningArchive.timeline.heatmapHint')}
                </p>
            </section>

            <ArchiveBucketDialog
                bucket={focusedBucket}
                plays={plays}
                granularity={granularity}
                isDaylight={isDaylight}
                onClose={() => setFocusedBucketKey(null)}
            />
        </div>
    );
};

export default TimelineTab;
