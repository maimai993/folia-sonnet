import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clapperboard, Search } from 'lucide-react';
import { searchBilibiliVideos } from '../../services/bilibili/api';
import { isBilibiliAvailable } from '../../services/bilibili/transport';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { songKeyOf } from '../bilibili/BilibiliMvLayer';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import { GroupLine } from './shell/GroupLine';
import { Button } from '@/components/ui';
import { PanelButton } from './shell/PanelButton';
import { PanelRow } from './shell/PanelRow';
import { Segments } from './shell/Segments';

// src/components/panelTab/MvSourceRow.tsx
//
// 「视频来源」一行：这首歌的播放页画面（MV 背景）从哪来。
//
// 与「歌词来源」对齐的布局 —— 歌词在哪一行的上面就轮到视频：
//   自动：按歌名 + 歌手搜 B 站、AI / 打分挑一条（默认）。
//   手动：从搜索结果里自己点一条，钉住这一首 —— 钉住后不再自动匹配。
//
// 只做「来源的选择与入口」，搜索弹窗本体在 MvMatchDialog；后续接别的视频平台时
// 在这里加一段来源（Segments 一格一个平台），不动播放链路。

interface MvSourceRowProps {
    /** 正在放的歌；没有它就没有「这首歌的视频」可言，整行不渲染。 */
    song: unknown;
}

interface MvCandidate {
    bvid: string;
    title: string;
    author: string;
    durationSec: number;
    coverUrl: string;
}

const MvSourceRow: React.FC<MvSourceRowProps> = ({ song }) => {
    const { t } = useTranslation();
    const [picking, setPicking] = useState(false);
    const [searching, setSearching] = useState(false);
    const [candidates, setCandidates] = useState<MvCandidate[]>([]);
    const [error, setError] = useState('');

    const title = (song as { name?: string | null } | null)?.name ?? '';
    const artist = song ? getSongArtistLabel(song as never) || '' : '';
    const songKey = songKeyOf(title, artist);

    const resolution = useBilibiliMvStore(state => state.bySongKey[songKey]);
    const pinning = useBilibiliMvStore(state => Boolean(songKey && state.inflight[songKey]));

    const sourceLabel = useMemo(() => {
        if (!resolution) return t('ui.mvSourceAuto');
        if (resolution.manual && resolution.state === 'ready') return resolution.stream?.title || t('ui.mvSourceManual');
        if (resolution.state === 'ready') return resolution.stream?.title || t('ui.mvSourceAuto');
        if (resolution.state === 'resolving') return t('ui.mvResolving');
        if (resolution.state === 'missing') return t('ui.mvSourceAuto');
        return t('ui.mvSourceAuto');
    }, [resolution, t]);

    const openPicker = async () => {
        if (!title.trim()) return;
        setPicking(true);
        setError('');
        setSearching(true);
        try {
            const hits = await searchBilibiliVideos(`${title} ${artist}`.trim());
            setCandidates(hits.slice(0, 20).map(hit => ({
                bvid: hit.bvid,
                title: hit.title,
                author: hit.author,
                durationSec: hit.durationSec,
                coverUrl: hit.coverUrl,
            })));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setCandidates([]);
        } finally {
            setSearching(false);
        }
    };

    const pick = async (bvid: string) => {
        await useBilibiliMvStore.getState().pinBv(songKey, bvid);
        setPicking(false);
    };

    return (
        <>
            <PanelRow label={t('ui.videoSource')}>
                <span className="truncate text-[13px] text-[color:var(--st-t2)]" title={sourceLabel}>
                    {pinning ? t('ui.mvResolving') : sourceLabel}
                </span>
                <PanelButton
                    icon={Clapperboard}
                    onClick={() => void openPicker()}
                    disabled={!isBilibiliAvailable() || !title.trim() || pinning}
                >
                    {t('ui.mvManualMatch')}
                </PanelButton>
            </PanelRow>
            {picking && (
                <div className="mx-1 mb-2 rounded-xl border border-white/10 bg-black/30 p-2">
                    <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[13px] font-bold text-[color:var(--st-t1)]">{t('ui.mvPickTitle')}</span>
                        <Button
                            type="button"
                            variant="bare"
                            className="text-xs text-[color:var(--st-t2)]"
                            onClick={() => setPicking(false)}
                        >
                            {t('ui.close')}
                        </Button>
                    </div>
                    {searching && <div className="py-4 text-center text-xs text-[color:var(--st-t2)]">{t('ui.mvSearching')}</div>}
                    {!searching && error && <div className="py-4 text-center text-xs text-red-400">{error}</div>}
                    {!searching && !error && candidates.length === 0 && (
                        <div className="py-4 text-center text-xs text-[color:var(--st-t2)]">{t('ui.mvNoResults')}</div>
                    )}
                    {!searching && candidates.length > 0 && (
                        <div className="max-h-64 space-y-1 overflow-y-auto">
                            {candidates.map(hit => (
                                <Button
                                    key={hit.bvid}
                                    type="button"
                                    variant="bare"
                                    className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left hover:bg-white/10"
                                    onClick={() => void pick(hit.bvid)}
                                >
                                    {hit.coverUrl && (
                                        <img src={hit.coverUrl} alt="" className="h-9 w-16 flex-none rounded object-cover" />
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-xs font-bold text-[color:var(--st-t1)]">{hit.title}</span>
                                        <span className="block truncate text-[11px] text-[color:var(--st-t2)]">
                                            {hit.author} · {Math.round(hit.durationSec / 60)}:{String(hit.durationSec % 60).padStart(2, '0')}
                                        </span>
                                    </span>
                                    <Search size={13} className="flex-none opacity-40" />
                                </Button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            <GroupLine />
        </>
    );
};

export default MvSourceRow;
