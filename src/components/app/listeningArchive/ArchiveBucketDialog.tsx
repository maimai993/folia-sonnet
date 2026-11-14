import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArchivePlay, ArchiveBucket, ArchiveGranularity } from '../../../services/listeningArchive/types';
import { bucketKeyOf } from '../../../services/listeningArchive/rules';
import ThemedDialog from '../../shared/ThemedDialog';
import { formatArchiveClock, formatArchiveDuration } from './listeningArchiveFormat';

// src/components/app/listeningArchive/ArchiveBucketDialog.tsx
// 时间轴上点开某一段之后看到的东西：这一段里听了哪些歌、各听了多久。
//
// 用共用的 ThemedDialog（外框、Esc、焦点都在那里），这一层只管内容。次数与总时长取桶自己
// 算好的值，明细按「这次播放的开始时刻落在这个桶里」筛 —— 与 aggregate.timelineBuckets 同一口径。

type ArchiveBucketDialogProps = {
    /** 被点开的那一段；null 表示没有开着。 */
    bucket: ArchiveBucket | null;
    plays: ArchivePlay[];
    granularity: ArchiveGranularity;
    isDaylight: boolean;
    onClose: () => void;
};

/** 明细最多铺这么多行：一段里几千次播放时，对话框不该被撑成一本账。 */
const MAX_ROWS = 60;

const ArchiveBucketDialog: React.FC<ArchiveBucketDialogProps> = ({
    bucket,
    plays,
    granularity,
    isDaylight,
    onClose,
}) => {
    const { t } = useTranslation();

    const rows = useMemo(() => {
        if (!bucket) return [];
        return plays
            .filter(play => bucketKeyOf(play.startedAt, granularity) === bucket.key)
            .sort((first, second) => first.startedAt - second.startedAt)
            .slice(0, MAX_ROWS);
    }, [bucket, granularity, plays]);

    return (
        <ThemedDialog
            isOpen={bucket !== null}
            onClose={onClose}
            isDaylight={isDaylight}
            size="m"
            title={bucket ? bucket.key : ''}
            description={bucket
                ? `${formatArchiveDuration(t, bucket.seconds)} · ${t('listeningArchive.playsCount', { count: bucket.plays })}`
                : undefined}
        >
            {rows.length === 0
                ? (
                    <p className="text-[13px] text-[color:var(--st-t3)]">
                        {t('listeningArchive.timeline.segmentEmpty')}
                    </p>
                )
                : (
                    <ul className="flex flex-col">
                        {rows.map(play => (
                            <li
                                key={play.id}
                                className="flex items-baseline gap-3 border-b border-[var(--st-line)] py-1.5 text-[12px] last:border-b-0"
                            >
                                <span className="shrink-0 tabular-nums text-[color:var(--st-t3)]">
                                    {formatArchiveClock(play.startedAt)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[color:var(--st-t1)]">
                                    {play.title}
                                </span>
                                <span className="shrink-0 text-[color:var(--st-t2)]">
                                    {formatArchiveDuration(t, play.listenedSeconds)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
        </ThemedDialog>
    );
};

export default ArchiveBucketDialog;
