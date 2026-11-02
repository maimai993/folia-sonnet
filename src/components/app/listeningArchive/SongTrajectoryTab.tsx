import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Music2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { ArchiveDayEntry, ArchivePlay } from '../../../services/listeningArchive/types';
import { rankEntries, songTrajectory } from '../../../services/listeningArchive/aggregate';
import { Button } from '@/components/ui';
import { useListeningArchiveSettingsStore } from '../../../stores/useListeningArchiveSettingsStore';
import { useListeningArchiveStore } from './listeningArchiveStore';
import {
    formatArchiveDate,
    formatArchiveDuration,
} from './listeningArchiveFormat';
import ArchiveBars from './ArchiveBars';
import ArchiveVirtualList, { type ArchiveVirtualRow } from './ArchiveVirtualList';

// src/components/app/listeningArchive/SongTrajectoryTab.tsx
// 单曲轨迹页：这一首累计听了多少次、多久，最近 24 个月各排第几，落在星期与小时的什么位置，
// 以及按日期的一天一天。数据全部来自 aggregate.songTrajectory（口径只有那一份）。
//
// 名次条的「高」是名次的前：第 1 名最高，第 24 名最矮，没上榜的那个月不画。这样一眼能看出
// 这首歌是「一直在这个月的榜上」还是「火过一阵就没了」。

/** 切换歌曲的候选：排前几名的歌各占一颗，点一下就换。 */
const SWITCHER_LIMIT = 12;
/** 名次条的高度按 1..RANK_FLOOR 的倒数铺。 */
const RANK_FLOOR = 25;
/** 按日时间轴的行高。 */
const DAY_ROW_HEIGHT = 28;
/** 最近 24 个月里每几条标一个月。 */
const MONTH_LABEL_EVERY = 4;

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

type SongTrajectoryTabProps = {
    plays: ArchivePlay[];
};

const SongTrajectoryTab: React.FC<SongTrajectoryTabProps> = ({ plays }) => {
    const { t } = useTranslation();
    const lowPerformance = useListeningArchiveSettingsStore(state => state.lowPerformance);
    const { trajectorySongKey, setTrajectorySongKey, setFocusedCover } = useListeningArchiveStore(useShallow(state => ({
        trajectorySongKey: state.trajectorySongKey,
        setTrajectorySongKey: state.setTrajectorySongKey,
        setFocusedCover: state.setFocusedCover,
    })));
    const [now] = useState(() => Date.now());

    const topSongs = useMemo(() => rankEntries(plays, 'song', 'plays').slice(0, SWITCHER_LIMIT), [plays]);
    const songKey = trajectorySongKey ?? topSongs[0]?.key ?? null;
    const trajectory = useMemo(
        () => (songKey ? songTrajectory(plays, songKey, now) : null),
        [now, plays, songKey],
    );

    const monthValues = useMemo(
        () => (trajectory?.monthly ?? []).map(month => (month.rank === null ? 0 : Math.max(1, RANK_FLOOR - month.rank))),
        [trajectory],
    );
    const monthLabels = useMemo(
        () => (trajectory?.monthly ?? []).map(month => month.month.slice(2)),
        [trajectory],
    );
    const weekdayLabels = useMemo(
        () => WEEKDAY_KEYS.map(key => t(`listeningArchive.timeline.weekdays.${key}`)),
        [t],
    );
    const hourLabels = useMemo(() => Array.from({ length: 24 }, (_, hour) => String(hour)), []);

    const DayRow = useMemo<ArchiveVirtualRow<ArchiveDayEntry>>(() => (
        function BoundDayRow({ row }) {
            return (
                <div className="flex h-7 items-center gap-3 border-b border-[var(--st-line)] text-[12px]">
                    <span className="shrink-0 tabular-nums text-[color:var(--st-t2)]">
                        {row.day}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[color:var(--st-t3)]">
                        {t('listeningArchive.playsCount', { count: row.plays })}
                    </span>
                    <span className="shrink-0 text-[color:var(--st-t1)]">
                        {formatArchiveDuration(t, row.seconds)}
                    </span>
                </div>
            );
        }
    ), [t]);

    if (!trajectory) {
        return (
            <p className="flex h-full items-center justify-center px-4 text-center text-[13px] text-[color:var(--st-t3)]">
                {t('listeningArchive.song.noData')}
            </p>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <header className="flex items-center gap-3">
                <Button
                    variant="bare"
                    className={`flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--st-fill)] ${
                        trajectory.coverUrl ? 'cursor-zoom-in' : 'cursor-default'
                    }`}
                    disabled={!trajectory.coverUrl}
                    aria-label={t('listeningArchive.rankings.zoomCover')}
                    onClick={() => {
                        if (!trajectory.coverUrl) return;
                        setFocusedCover({
                            url: trajectory.coverUrl,
                            title: trajectory.title,
                            subtitle: trajectory.artists.join(' / '),
                        });
                    }}
                >
                    {trajectory.coverUrl
                        ? <img src={trajectory.coverUrl} alt="" className="h-full w-full object-cover" />
                        : <Music2 size={20} className="opacity-40" />}
                </Button>
                <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] text-[color:var(--st-t1)]">{trajectory.title}</h3>
                    <p className="truncate text-[12px] text-[color:var(--st-t2)]">{trajectory.artists.join(' / ')}</p>
                    <p className="mt-0.5 text-[11px] text-[color:var(--st-t2)]">
                        {t('listeningArchive.song.playsAndTime', {
                            plays: t('listeningArchive.playsCount', { count: trajectory.plays }),
                            duration: formatArchiveDuration(t, trajectory.seconds),
                        })}
                    </p>
                    <p className="text-[10px] text-[color:var(--st-t3)]">
                        {t('listeningArchive.song.firstHeard', { date: formatArchiveDate(trajectory.firstHeardAt) })}
                        {' · '}
                        {t('listeningArchive.song.lastHeard', { date: formatArchiveDate(trajectory.lastHeardAt) })}
                    </p>
                </div>
            </header>

            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
                {topSongs.map(song => (
                    <Button
                        key={song.key}
                        variant={song.key === songKey ? 'fill' : 'quiet'}
                        className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[11px] ${
                            song.key === songKey ? 'text-[color:var(--st-accent)]' : 'text-[color:var(--st-t2)]'
                        }`}
                        onClick={() => setTrajectorySongKey(song.key)}
                    >
                        {song.title}
                    </Button>
                ))}
            </div>

            <section>
                <h4 className="mb-1 text-[12px] text-[color:var(--st-t2)]">{t('listeningArchive.song.monthlyTitle')}</h4>
                <ArchiveBars
                    values={monthValues}
                    labels={monthLabels}
                    labelEvery={MONTH_LABEL_EVERY}
                    animate={!lowPerformance}
                    emptyLabel={t('listeningArchive.song.monthlyEmpty')}
                    barLabel={index => {
                        const month = trajectory.monthly[index];
                        if (!month) return '';
                        return month.rank === null
                            ? `${month.month} · ${t('listeningArchive.song.unranked')}`
                            : `${month.month} · ${t('listeningArchive.song.rankLabel', { rank: month.rank })}`;
                    }}
                />
            </section>

            <div className="grid gap-4 md:grid-cols-2">
                <section>
                    <h4 className="mb-1 text-[12px] text-[color:var(--st-t2)]">{t('listeningArchive.song.weekdayTitle')}</h4>
                    <ArchiveBars values={trajectory.weekdaySeconds} labels={weekdayLabels} animate={!lowPerformance} />
                </section>
                <section>
                    <h4 className="mb-1 text-[12px] text-[color:var(--st-t2)]">{t('listeningArchive.song.hourlyTitle')}</h4>
                    <ArchiveBars
                        values={trajectory.hourlySeconds}
                        labels={hourLabels}
                        labelEvery={6}
                        animate={!lowPerformance}
                    />
                </section>
            </div>

            <section className="flex min-h-0 flex-col">
                <h4 className="mb-1 text-[12px] text-[color:var(--st-t2)]">{t('listeningArchive.song.daysTitle')}</h4>
                <div className="h-[220px]">
                    <ArchiveVirtualList
                        rows={trajectory.days}
                        rowHeight={DAY_ROW_HEIGHT}
                        itemKey={day => day.day}
                        Row={DayRow}
                    />
                </div>
            </section>
        </div>
    );
};

export default SongTrajectoryTab;
