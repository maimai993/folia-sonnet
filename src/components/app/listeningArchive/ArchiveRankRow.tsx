import React from 'react';
import { useTranslation } from 'react-i18next';
import { Music2 } from 'lucide-react';
import type { ArchiveRankEntry, ArchiveRankKind } from '../../../services/listeningArchive/types';
import { Button } from '@/components/ui';
import { formatArchiveDuration } from './listeningArchiveFormat';
import type { ArchiveFocusedCover } from './listeningArchiveStore';

// src/components/app/listeningArchive/ArchiveRankRow.tsx
// 排行里的一行：封面、主标题、副标题，右边是次数与时长。
//
// 封面是按钮（点开大图看是哪一张），歌曲视角下标题也是按钮（进那一首的轨迹）：两件事分开，
// 点封面不会顺带换页。歌手 / 专辑视角没有单曲轨迹可进，标题就只是文字。

type ArchiveRankRowProps = {
    entry: ArchiveRankEntry;
    rankKind: ArchiveRankKind;
    /** 早于这一刻算「以前就听过」，晚于它才标「新遇见」。 */
    newSince: number;
    onFocusCover: (cover: ArchiveFocusedCover) => void;
    onOpenTrajectory: (songKey: string) => void;
};

const ArchiveRankRow: React.FC<ArchiveRankRowProps> = ({
    entry,
    rankKind,
    newSince,
    onFocusCover,
    onOpenTrajectory,
}) => {
    const { t } = useTranslation();
    const isNew = entry.firstHeardAt >= newSince;
    const coverAction = () => {
        if (!entry.coverUrl) return;
        onFocusCover({ url: entry.coverUrl, title: entry.title, subtitle: entry.subtitle });
    };

    return (
        <div className="flex h-16 items-center gap-3 border-b border-[var(--st-line)] px-1">
            <Button
                variant="bare"
                className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--st-fill)] ${
                    entry.coverUrl ? 'cursor-zoom-in' : 'cursor-default'
                }`}
                onClick={coverAction}
                disabled={!entry.coverUrl}
                aria-label={t('listeningArchive.rankings.zoomCover')}
            >
                {entry.coverUrl
                    ? <img src={entry.coverUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                    : <Music2 size={16} className="opacity-40" />}
            </Button>

            <div className="min-w-0 flex-1">
                {rankKind === 'song'
                    ? (
                        <Button
                            variant="bare"
                            className="block max-w-full truncate text-left text-[13px] text-[color:var(--st-t1)]"
                            onClick={() => onOpenTrajectory(entry.key)}
                            tip={t('listeningArchive.rankings.openTrajectory')}
                        >
                            {entry.title}
                        </Button>
                    )
                    : <p className="truncate text-[13px] text-[color:var(--st-t1)]">{entry.title}</p>}
                <p className="truncate text-[11px] text-[color:var(--st-t2)]">
                    {entry.subtitle}
                    {isNew && (
                        <span className="ml-1.5 rounded-full bg-[var(--st-fill2)] px-1.5 py-0.5 text-[10px] text-[color:var(--st-accent)]">
                            {t('listeningArchive.rankings.newBadge')}
                        </span>
                    )}
                </p>
            </div>

            <div className="shrink-0 text-right text-[11px] leading-4 text-[color:var(--st-t2)]">
                <p>{t('listeningArchive.playsCount', { count: entry.plays })}</p>
                <p>{formatArchiveDuration(t, entry.seconds)}</p>
            </div>
        </div>
    );
};

export default ArchiveRankRow;
