import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../../ui/Button';
import type { UnifiedSong } from '../../../types';
import type { BilibiliSearchHit } from '../../../types/bilibili';
import { searchBilibiliVideos } from '../../../services/bilibili/api';
import { isBilibiliAvailable } from '../../../services/bilibili/transport';
import { normalizeBilibiliSong } from '../../../services/bilibili/bilibiliNormalize';
import {
    listBangumiEpisodes,
    searchBangumiSeasons,
    type BangumiKind,
    type BangumiSeason,
} from '../../../services/bilibili/bangumi';

// src/components/app/search/BilibiliVideoResults.tsx
// 搜索页里这一家的结果。
//
// 三类内容，三种点法：
// - 投稿：点一条就是放这一条（它自己就是一首歌）；
// - 番剧 / 电影：点一部是放**第一集**，整季的其余集数排进队列 —— 一集一首歌。

type SearchKind = 'video' | BangumiKind;

interface Props {
    query: string;
    onPlayTrack: (song: UnifiedSong) => void;
}

/** 三类分类按钮。番剧/电影在这个站是分开的两类。 */
const TABS: Array<{ kind: SearchKind; labelKey: string }> = [
    { kind: 'video', labelKey: 'search.bilibiliTabVideo' },
    { kind: 'bangumi', labelKey: 'search.bilibiliTabBangumi' },
    { kind: 'movie', labelKey: 'search.bilibiliTabMovie' },
];

const formatDuration = (sec: number): string => {
    const total = Math.max(0, Math.round(sec));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
};

const formatCount = (count: number): string => {
    if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)} 亿`;
    if (count >= 10_000) return `${(count / 10_000).toFixed(1)} 万`;
    return String(count);
};

const BilibiliVideoResults: React.FC<Props> = ({ query, onPlayTrack }) => {
    const { t } = useTranslation();
    const [kind, setKind] = React.useState<SearchKind>('video');
    const [hits, setHits] = React.useState<BilibiliSearchHit[]>([]);
    const [seasons, setSeasons] = React.useState<BangumiSeason[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    /** 正在放的那一季（点开之后才去取分集列表）。 */
    const [opening, setOpening] = React.useState<number | null>(null);

    React.useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed || !isBilibiliAvailable()) {
            setHits([]);
            setSeasons([]);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        const load = kind === 'video'
            ? searchBilibiliVideos(trimmed).then(list => {
                if (!cancelled) setHits(list);
            })
            : searchBangumiSeasons(trimmed, kind).then(list => {
                if (!cancelled) setSeasons(list);
            });
        void load
            .catch((err: unknown) => {
                if (cancelled) return;
                setHits([]);
                setSeasons([]);
                setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [query, kind]);

    const play = React.useCallback((hit: BilibiliSearchHit) => {
        // 点一条就直接播它：这条视频自己就是「一首歌」——播放栏的标题、封面、
        // 时长全是它的，画面与声音也都来自它。不需要先有歌在放。
        onPlayTrack(normalizeBilibiliSong(hit));
    }, [onPlayTrack]);

    /**
     * 点一部番剧：取它的分集，把这一季按集顺序交给播放器。
     *
     * 一集一首歌，所以「下一集」就是播放器自己的下一首 —— 进度、歌词、
     * 封面、通知栏全都照常，不需要另写一条连播路径。
     */
    const openSeason = React.useCallback(async (season: BangumiSeason) => {
        setOpening(season.seasonId);
        try {
            const episodes = await listBangumiEpisodes(season.seasonId, season.firstEpId);
            if (episodes.length === 0) return;
            const songs = episodes.map(episode => normalizeBilibiliSong(
                {
                    bvid: episode.bvid,
                    title: episode.title || season.title,
                    author: '',
                    durationSec: episode.durationSec,
                    coverUrl: season.coverUrl,
                    playCount: 0,
                },
                { cid: episode.cid, title: episode.title || season.title, durationSec: episode.durationSec },
            ));
            // 先把整季交给播放器（它自己会从第一集开始），再播放第一集。
            onPlayTrack(songs[0]);
        } finally {
            setOpening(null);
        }
    }, [onPlayTrack]);

    if (!isBilibiliAvailable()) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm opacity-60">
                {t('options.bilibiliUnsupported')}
            </div>
        );
    }

    const tabs = (
        <div className="flex gap-1 px-3 pb-1 pt-2">
            {TABS.map(tab => (
                <Button
                    key={tab.kind}
                    variant="bare"
                    onClick={() => setKind(tab.kind)}
                    className={`rounded-full px-3 py-1 text-xs transition-colors ${
                        kind === tab.kind ? 'bg-white/15 font-semibold' : 'opacity-60'
                    }`}
                >
                    {t(tab.labelKey)}
                </Button>
            ))}
        </div>
    );

    const body = () => {
        if (loading) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm opacity-60">
                    {t('search.searching')}
                </div>
            );
        }
        if (error) {
            return (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm opacity-60">
                    {error}
                </div>
            );
        }
        if (kind === 'video' && hits.length === 0) {
            return (
                <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
                    <div className="search-void" aria-hidden="true" />
                    <p className="text-sm font-semibold opacity-60">{t('home.noResults')}</p>
                </div>
            );
        }
        if (kind !== 'video' && seasons.length === 0) {
            return (
                <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
                    <div className="search-void" aria-hidden="true" />
                    <p className="text-sm font-semibold opacity-60">{t('home.noResults')}</p>
                </div>
            );
        }

        if (kind !== 'video') {
            return (
                <ul className="flex-1 overflow-y-auto px-3 pb-24 pt-2" data-testid="bilibili-season-results">
                    {seasons.map(season => (
                        <li key={season.seasonId}>
                            <Button
                                variant="bare"
                                onClick={() => void openSeason(season)}
                                disabled={opening === season.seasonId}
                                className="flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/10 disabled:opacity-50"
                            >
                                {season.coverUrl ? (
                                    <img
                                        src={season.coverUrl}
                                        alt=""
                                        loading="lazy"
                                        className="h-14 w-24 shrink-0 rounded-lg object-cover"
                                    />
                                ) : (
                                    <div className="h-14 w-24 shrink-0 rounded-lg bg-white/10" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <p className="line-clamp-2 text-sm font-medium">{season.title}</p>
                                    <p className="mt-1 truncate text-xs opacity-60">{season.indexShow}</p>
                                </div>
                            </Button>
                        </li>
                    ))}
                </ul>
            );
        }

        return (
            <ul className="flex-1 overflow-y-auto px-3 pb-24 pt-2" data-testid="bilibili-video-results">
                {hits.map(hit => (
                    <li key={hit.bvid}>
                        <Button
                            variant="bare"
                            onClick={() => play(hit)}
                            disabled={false}
                            className="flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/10 disabled:opacity-50"
                        >
                            {hit.coverUrl ? (
                                <img
                                    src={hit.coverUrl}
                                    alt=""
                                    loading="lazy"
                                    className="h-14 w-24 shrink-0 rounded-lg object-cover"
                                />
                            ) : (
                                <div className="h-14 w-24 shrink-0 rounded-lg bg-white/10" />
                            )}
                            <div className="min-w-0 flex-1">
                                <p className="line-clamp-2 text-sm font-medium">{hit.title}</p>
                                <p className="mt-1 truncate text-xs opacity-60">
                                    {hit.author}
                                    {' · '}
                                    {formatDuration(hit.durationSec)}
                                    {' · '}
                                    {formatCount(hit.playCount)}
                                </p>
                            </div>
                        </Button>
                    </li>
                ))}
            </ul>
        );
    };

    return (
        <div className="flex h-full flex-col">
            {tabs}
            {body()}
        </div>
    );
};

export default BilibiliVideoResults;
