import React from 'react';
import { useTranslation } from 'react-i18next';
import { searchBilibiliVideos } from '../../../services/bilibili/api';
import type { BilibiliSearchHit } from '../../../types/bilibili';
import { isBilibiliAvailable } from '../../../services/bilibili/transport';
import type { UnifiedSong } from '../../../types';
import { normalizeBilibiliSong } from '../../../services/bilibili/bilibiliNormalize';
import { Button } from '../../ui/Button';

// src/components/app/search/BilibiliVideoResults.tsx
// 搜索页里「B 站」那一栏：搜视频，点一条直接在播放页当背景放。
//
// 它和歌曲结果不是一回事 —— 结果是视频（封面、UP 主、时长、播放量），点了不是「播放这首歌」
// 而是「把这条视频铺到正在放的那首歌上」。所以单独一个列表，混进 SearchResultsList 里
// 反而要处处判类型。
//
// 只在有原生代发的平台上出现（安卓），别处这一栏根本不会列出来。

type Props = {
    query: string;
    /** 点一条视频，就把它当成一首歌交给播放器（画面和声音都是它的）。 */
    onPlayTrack: (song: UnifiedSong) => void;
};

const formatCount = (n: number): string => (
    n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n)
);

const formatDuration = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
};

const BilibiliVideoResults: React.FC<Props> = ({ query, onPlayTrack }) => {
    const { t } = useTranslation();
    const [hits, setHits] = React.useState<BilibiliSearchHit[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed || !isBilibiliAvailable()) {
            setHits([]);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        void searchBilibiliVideos(trimmed)
            .then(list => {
                if (!cancelled) setHits(list);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setHits([]);
                setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [query]);

    const play = React.useCallback((hit: BilibiliSearchHit) => {
        // 点一条就直接播它：这条视频自己就是「一首歌」——播放栏的标题、封面、
        // 时长全是它的，画面与声音也都来自它。不需要先有歌在放。
        onPlayTrack(normalizeBilibiliSong(hit));
    }, [onPlayTrack]);

    if (!isBilibiliAvailable()) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm opacity-60">
                {t('options.bilibiliUnsupported')}
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-sm opacity-60">
                {t('search.searching')}
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm opacity-60">
                {error}
            </div>
        );
    }

    if (hits.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                <div className="search-void" aria-hidden="true" />
                <p className="text-sm font-semibold opacity-60">{t('home.noResults')}</p>
            </div>
        );
    }

    return (
        <ul className="h-full overflow-y-auto px-3 pb-24 pt-2" data-testid="bilibili-video-results">
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

export default BilibiliVideoResults;
