import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type {
    ArchivePlay,
    ArchiveRankEntry,
    ArchiveRankKind,
    ArchiveRankSort,
} from '../../../services/listeningArchive/types';
import { rankEntries } from '../../../services/listeningArchive/aggregate';
import { TextField } from '@/components/ui';
import { Segmented, Select } from '@/components/modal/settings/kit';
import { useListeningArchiveStore, type ArchiveRangePreset } from './listeningArchiveStore';
import { rangeStartOf, RANGE_PRESETS } from './listeningArchiveFormat';
import ArchiveRankRow from './ArchiveRankRow';
import ArchiveVirtualList, { type ArchiveVirtualRow } from './ArchiveVirtualList';

// src/components/app/listeningArchive/RankingsTab.tsx
// 排行页：歌曲 / 歌手 / 专辑三个视角，按次数、时长或「新遇见」排，带搜索与时间范围。
//
// 聚合全交给 aggregate.rankEntries（口径只有那一份）。这里只做两件界面上的事：把范围档位
// 换成起点时刻，以及把点封面的动作接到大图上、把点歌名的动作接到单曲轨迹上。

const RANK_ROW_HEIGHT = 64;

type RankingsTabProps = {
    plays: ArchivePlay[];
};

const RankingsTab: React.FC<RankingsTabProps> = ({ plays }) => {
    const { t } = useTranslation();
    const {
        rankKind,
        rankSort,
        query,
        range,
        setRankKind,
        setRankSort,
        setQuery,
        setRange,
        setFocusedCover,
        openTrajectory,
    } = useListeningArchiveStore(useShallow(state => ({
        rankKind: state.rankKind,
        rankSort: state.rankSort,
        query: state.query,
        range: state.range,
        setRankKind: state.setRankKind,
        setRankSort: state.setRankSort,
        setQuery: state.setQuery,
        setRange: state.setRange,
        setFocusedCover: state.setFocusedCover,
        openTrajectory: state.openTrajectory,
    })));

    const rangeStart = rangeStartOf(range);
    const visiblePlays = useMemo(
        () => (rangeStart > 0 ? plays.filter(play => play.endedAt >= rangeStart) : plays),
        [plays, rangeStart],
    );
    const entries = useMemo(
        () => rankEntries(visiblePlays, rankKind, rankSort, query),
        [visiblePlays, query, rankKind, rankSort],
    );

    const kindOptions = useMemo<Array<{ value: ArchiveRankKind; label: string }>>(() => ([
        { value: 'song', label: t('listeningArchive.rankings.kindSong') },
        { value: 'artist', label: t('listeningArchive.rankings.kindArtist') },
        { value: 'album', label: t('listeningArchive.rankings.kindAlbum') },
    ]), [t]);
    const sortOptions = useMemo<Array<{ value: ArchiveRankSort; label: string }>>(() => ([
        { value: 'plays', label: t('listeningArchive.rankings.sortPlays') },
        { value: 'seconds', label: t('listeningArchive.rankings.sortSeconds') },
        { value: 'newest', label: t('listeningArchive.rankings.sortNewest') },
    ]), [t]);
    const rangeOptions = useMemo<Array<{ value: ArchiveRangePreset; label: string }>>(
        () => RANGE_PRESETS.map(preset => ({
            value: preset,
            label: t(`listeningArchive.ranges.${preset}`),
        })),
        [t],
    );

    // 绑定好行组件的三个回调，交给虚拟列表；身份随这三个回调变化。
    const Row = useMemo<ArchiveVirtualRow<ArchiveRankEntry>>(() => (
        function BoundRankRow({ row }) {
            return (
                <ArchiveRankRow
                    entry={row}
                    rankKind={rankKind}
                    newSince={rangeStart}
                    onFocusCover={setFocusedCover}
                    onOpenTrajectory={openTrajectory}
                />
            );
        }
    ), [openTrajectory, rangeStart, rankKind, setFocusedCover]);

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Segmented value={rankKind} options={kindOptions} onChange={setRankKind} />
                <Segmented value={rankSort} options={sortOptions} onChange={setRankSort} />
                <Select
                    value={range}
                    options={rangeOptions}
                    onChange={setRange}
                    name={t('listeningArchive.rankings.rangeName')}
                />
                <div className="relative min-w-[150px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-45" />
                    <TextField
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        placeholder={t('listeningArchive.rankings.searchPlaceholder')}
                        aria-label={t('listeningArchive.rankings.searchPlaceholder')}
                        className="w-full rounded-lg border border-[var(--st-line2)] bg-transparent py-1.5 pl-8 pr-3 text-[13px] text-[color:var(--st-t1)] outline-none placeholder:text-[color:var(--st-t3)]"
                    />
                </div>
            </div>

            <div className="min-h-0 flex-1">
                {entries.length === 0
                    ? (
                        <p className="flex h-full items-center justify-center px-4 text-center text-[13px] text-[color:var(--st-t3)]">
                            {query.trim() ? t('listeningArchive.rankings.noMatches') : t('listeningArchive.empty')}
                        </p>
                    )
                    : (
                        <ArchiveVirtualList
                            rows={entries}
                            rowHeight={RANK_ROW_HEIGHT}
                            itemKey={entry => entry.key}
                            Row={Row}
                            ariaLabel={t('listeningArchive.tabs.rankings')}
                        />
                    )}
            </div>
        </div>
    );
};

export default RankingsTab;
