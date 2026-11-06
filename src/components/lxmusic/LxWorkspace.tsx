import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextField } from '../ui';
import { ArrowLeft, Play, Plus, RefreshCw, Search } from 'lucide-react';
import type { Theme, UnifiedSong } from '../../types';
import type { ProviderCollection } from '../../types/onlineMusic';
import { useLxWorkspaceStore, type LxWorkspaceTab } from '../../stores/useLxWorkspaceStore';
import { lxBrowse, lxmusicProvider } from '../../services/onlineMusic/lxmusic/lxmusicProvider';
import { lxSourceStore } from '../../services/onlineMusic/lxmusic/lxSourceStore';
import { getLxPreferences } from '../../services/onlineMusic/lxmusic/lxPreferences';
import {
    LX_PUBLIC_PLATFORMS,
    type LxApiChart,
    type LxApiRadioProgram,
    type LxPublicPlatform,
} from '../../services/onlineMusic/lxmusic/lxPublicApi';
import { LxTrackList } from './LxTrackList';
import { LxSourcePanel } from './LxSourcePanel';
import { errorText, formatCount, formatDate, platformBadge } from './lxUi';
import './lxWorkspace.css';

// src/components/lxmusic/LxWorkspace.tsx
// 洛雪工作台：照洛雪移动端的「歌单」页重排。
//   头部一行标题 + 音源入口，下面一条分段胶囊（歌单 / 电台 / 专辑 / 榜单 / 本地 / 搜索），
//   再下面一排平台按钮（网易云 / QQ音乐 / 酷狗 / 酷我）——换平台就换这一页的内容。
//   歌单、专辑、电台都是封面网格，点开是曲目表；榜单左榜右歌；搜索四家一起搜。

const PILLS: ReadonlyArray<{ key: LxWorkspaceTab; label: string }> = [
    { key: 'playlist', label: '歌单' },
    { key: 'radio', label: '电台' },
    { key: 'album', label: '专辑' },
    { key: 'chart', label: '榜单' },
    { key: 'local', label: '本地' },
    { key: 'search', label: '搜索' },
];

/** 这两页不分平台，平台按钮跟着藏起来。 */
const GLOBAL_TABS: ReadonlyArray<LxWorkspaceTab> = ['search', 'local', 'source'];

// 一页 30：酷狗的歌单广场接口固定每页 30 条，页大小对不上的话翻页会漏歌。
const PAGE_SIZE = 30;
const TRACK_PAGE_SIZE = 60;
/** 搜索时每个平台各取多少（四家交替，一屏大概 4 倍条数）。 */
const SEARCH_PAGE_SIZE = 24;

type DetailView = {
    kind: 'playlist' | 'album';
    platform: LxPublicPlatform;
    id: string;
    title: string;
    subtitle?: string;
    coverUrl?: string;
};

type LxWorkspaceProps = {
    theme: Theme;
    isDaylight: boolean;
    onClose: () => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddToQueue: (track: UnifiedSong) => void;
};

const platformOfCollection = (collection: ProviderCollection, fallback: LxPublicPlatform): LxPublicPlatform => {
    const raw = collection.providerData?.platform;
    if (raw === 'wy' || raw === 'kg' || raw === 'kw' || raw === 'tx') return raw;
    return fallback;
};

export const LxWorkspace: React.FC<LxWorkspaceProps> = ({ theme, isDaylight, onClose, onPlayTrack, onAddToQueue }) => {
    const tab = useLxWorkspaceStore((state) => state.tab);
    const setTab = useLxWorkspaceStore((state) => state.setTab);

    const [platform, setPlatform] = useState<LxPublicPlatform>('wy');
    // 回调里读当前平台：请求回来时若用户已经换了平台，就别把旧结果写进去。
    const platformRef = useRef(platform);
    platformRef.current = platform;
    const tabRef = useRef(tab);
    tabRef.current = tab;

    // 音源变动后重算「能不能放」的提示（store 不是响应式的，用一个计数逼一次重渲染）。
    const [, bumpSourceTick] = useState(0);
    const sourceCount = lxSourceStore.getSources().filter((source) => source.enabled).length;
    const handleSourceChanged = useCallback(() => bumpSourceTick((prev) => prev + 1), []);
    const [refreshTick, setRefreshTick] = useState(0);

    // 播放回执：播放器在浮层底下，点完不给一句反馈会以为没反应。
    const [playHint, setPlayHint] = useState<string | null>(null);
    const playHintTimer = useRef<number | null>(null);
    const showHint = useCallback((text: string, durationMs = 2600) => {
        setPlayHint(text);
        if (playHintTimer.current) window.clearTimeout(playHintTimer.current);
        playHintTimer.current = window.setTimeout(() => setPlayHint(null), durationMs);
    }, []);
    const handlePlay = useCallback((song: UnifiedSong) => {
        // 播放一律先走导入的音源；只有「一个音源都没有、且连公开直链兜底也关了」才拦下来。
        const hasSources = lxSourceStore.canResolveAny('musicUrl');
        if (!hasSources && !getLxPreferences().allowPublicFallback) {
            showHint('还没有可用的音源，且已关闭公开直链兜底，先去右上角「音源」导入一个', 3600);
            return;
        }
        onPlayTrack(song);
        showHint(hasSources ? `正在播放 · ${song.name}` : `未导入音源，尝试公开直链 · ${song.name}`);
    }, [onPlayTrack, showHint]);
    useEffect(() => () => {
        if (playHintTimer.current) window.clearTimeout(playHintTimer.current);
    }, []);

    // 歌单 / 专辑 / 电台 共用一个列表状态
    const [collections, setCollections] = useState<ProviderCollection[]>([]);
    const [programs, setPrograms] = useState<LxApiRadioProgram[]>([]);
    const [browseLoading, setBrowseLoading] = useState(false);
    const [browseHasMore, setBrowseHasMore] = useState(false);
    const [browseOffset, setBrowseOffset] = useState(0);
    const [browseError, setBrowseError] = useState<string | null>(null);

    // 歌单 / 专辑里的曲目
    const [detail, setDetail] = useState<DetailView | null>(null);
    const [detailSongs, setDetailSongs] = useState<UnifiedSong[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailHasMore, setDetailHasMore] = useState(false);
    const [detailOffset, setDetailOffset] = useState(0);
    const [detailError, setDetailError] = useState<string | null>(null);

    // 榜单
    const [charts, setCharts] = useState<LxApiChart[]>([]);
    const [chartId, setChartId] = useState<string | null>(null);
    const [chartSongs, setChartSongs] = useState<UnifiedSong[]>([]);
    const [chartLoading, setChartLoading] = useState(false);
    const [chartError, setChartError] = useState<string | null>(null);

    // 搜索
    const [query, setQuery] = useState('');
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [searchSongs, setSearchSongs] = useState<UnifiedSong[]>([]);
    const [searchOffset, setSearchOffset] = useState(0);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    // ------------------------------------------------------------ 歌单 / 专辑 / 电台

    const loadBrowse = useCallback(async (targetPlatform: LxPublicPlatform, targetTab: LxWorkspaceTab, offset: number, append: boolean) => {
        setBrowseLoading(true);
        if (!append) setBrowseError(null);
        try {
            if (targetTab === 'radio') {
                const page = await lxBrowse.radioPrograms(targetPlatform, PAGE_SIZE, offset);
                if (platformRef.current !== targetPlatform || tabRef.current !== targetTab) return;
                setPrograms((prev) => (append ? [...prev, ...page.items] : page.items));
                setBrowseOffset(offset + page.items.length);
                setBrowseHasMore(page.hasMore);
                return;
            }
            const page = targetTab === 'album'
                ? await lxBrowse.albumSquare(targetPlatform, PAGE_SIZE, offset)
                : await lxBrowse.playlistSquare(targetPlatform, PAGE_SIZE, offset);
            if (platformRef.current !== targetPlatform || tabRef.current !== targetTab) return;
            const items = page.items.map(lxBrowse.toCollection);
            setCollections((prev) => (append ? [...prev, ...items] : items));
            setBrowseOffset(offset + page.items.length);
            setBrowseHasMore(page.hasMore);
        } catch (error) {
            if (platformRef.current !== targetPlatform) return;
            setBrowseError(`${targetTab === 'album' ? '专辑' : targetTab === 'radio' ? '电台' : '歌单'}读取失败：${errorText(error)}`);
        } finally {
            setBrowseLoading(false);
        }
    }, []);

    useEffect(() => {
        if (tab !== 'playlist' && tab !== 'album' && tab !== 'radio') return;
        setCollections([]);
        setPrograms([]);
        setBrowseOffset(0);
        setBrowseHasMore(false);
        void loadBrowse(platform, tab, 0, false);
    }, [tab, platform, refreshTick, loadBrowse]);

    // ------------------------------------------------------------ 榜单

    useEffect(() => {
        if (tab !== 'chart') return undefined;
        let cancelled = false;
        setChartError(null);
        setCharts([]);
        setChartId(null);
        setChartSongs([]);
        void lxBrowse.charts(platform)
            .then((list) => {
                if (cancelled) return;
                setCharts(list);
                setChartId(list[0]?.id ?? null);
                if (list.length === 0) setChartError('这个平台没有可读的榜单。');
            })
            .catch((error) => {
                if (!cancelled) setChartError(`榜单读取失败：${errorText(error)}`);
            });
        return () => { cancelled = true; };
    }, [tab, platform, refreshTick]);

    useEffect(() => {
        if (tab !== 'chart' || !chartId) return undefined;
        let cancelled = false;
        setChartLoading(true);
        setChartSongs([]);
        setChartError(null);
        void lxBrowse.chartTracks(platform, chartId, TRACK_PAGE_SIZE, 0)
            .then((page) => {
                if (cancelled) return;
                setChartSongs(page.items.map(lxBrowse.toSong));
            })
            .catch((error) => {
                if (!cancelled) setChartError(`榜单曲目读取失败：${errorText(error)}`);
            })
            .finally(() => { if (!cancelled) setChartLoading(false); });
        return () => { cancelled = true; };
    }, [tab, platform, chartId]);

    // ------------------------------------------------------------ 曲目表

    const openCollection = useCallback(async (view: DetailView) => {
        setDetail(view);
        setDetailSongs([]);
        setDetailHasMore(false);
        setDetailOffset(0);
        setDetailError(null);
        setDetailLoading(true);
        try {
            const page = view.kind === 'album'
                ? await lxBrowse.albumTracks(view.platform, view.id, TRACK_PAGE_SIZE, 0)
                : await lxBrowse.playlistTracks(view.platform, view.id, TRACK_PAGE_SIZE, 0);
            setDetailSongs(page.items.map(lxBrowse.toSong));
            setDetailOffset(page.items.length);
            setDetailHasMore(page.hasMore);
        } catch (error) {
            setDetailError(`曲目读取失败：${errorText(error)}`);
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const openPlaylistCard = useCallback((collection: ProviderCollection) => {
        const owner = platformOfCollection(collection, platform);
        // 卡片 id 是带平台前缀的 `wy:123`；调接口要用原生 id（providerData 里留着）。
        const nativeId = typeof collection.providerData?.nativeId === 'string'
            ? collection.providerData.nativeId
            : String(collection.id);
        const kind = collection.type === 'album' ? 'album' : 'playlist';
        void openCollection({
            kind,
            platform: owner,
            id: nativeId,
            title: collection.name,
            subtitle: [collection.creator?.nickname, formatDate(collection.updatedAt)].filter(Boolean).join(' · '),
            coverUrl: collection.coverUrl,
        });
    }, [openCollection, platform]);

    const loadMoreDetail = useCallback(async () => {
        if (!detail || detailLoading) return;
        setDetailLoading(true);
        try {
            const page = detail.kind === 'album'
                ? await lxBrowse.albumTracks(detail.platform, detail.id, TRACK_PAGE_SIZE, detailOffset)
                : await lxBrowse.playlistTracks(detail.platform, detail.id, TRACK_PAGE_SIZE, detailOffset);
            setDetailSongs((prev) => [...prev, ...page.items.map(lxBrowse.toSong)]);
            setDetailOffset((prev) => prev + page.items.length);
            setDetailHasMore(page.hasMore);
        } catch (error) {
            setDetailError(`曲目读取失败：${errorText(error)}`);
        } finally {
            setDetailLoading(false);
        }
    }, [detail, detailLoading, detailOffset]);

    // ------------------------------------------------------------ 搜索

    const runSearch = useCallback(async (keyword: string, append: boolean) => {
        const trimmed = keyword.trim();
        if (!trimmed) return;
        setSearchLoading(true);
        if (!append) setSearchError(null);
        const offset = append ? searchOffset : 0;
        try {
            // limit 是「每个平台各取多少」，所以一页最多 4 倍条数。
            const page = await lxmusicProvider.search?.searchSongs?.(trimmed, SEARCH_PAGE_SIZE, offset);
            if (!page) {
                setSearchError('搜索没有返回结果。');
                return;
            }
            setSubmittedQuery(trimmed);
            setSearchSongs((prev) => (append ? [...prev, ...page.items] : page.items));
            setSearchHasMore(page.hasMore);
            setSearchOffset(append ? page.nextOffset : SEARCH_PAGE_SIZE);
        } catch (error) {
            setSearchError(`搜索失败：${errorText(error)}`);
        } finally {
            setSearchLoading(false);
        }
    }, [searchOffset]);

    // ------------------------------------------------------------ 渲染片段

    // 酷我 / 酷狗有公开的免费直链（付费 / 独家曲目才需要音源），网易云与 QQ 只能靠导入的音源。
    const hasFreeDirect = (target: string): boolean => target === 'kw' || target === 'kg';

    // 跨平台兜底之后，「这一家没有音源」不再等于放不了：只要还有任意一个音源就行。
    const hasAnySource = lxSourceStore.canResolveAny('musicUrl');
    const canPlayOn = (target: string): boolean => hasFreeDirect(target) || hasAnySource;

    const showPlatformRow = !GLOBAL_TABS.includes(tab);

    const platformRow = showPlatformRow ? (
        <div className="lx-platforms" role="tablist" aria-label="平台">
            {LX_PUBLIC_PLATFORMS.map((item) => (
                <Button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={platform === item.key}
                    className="lx-platform"
                    data-active={platform === item.key}
                    style={{ '--lx-platform-color': item.color } as React.CSSProperties}
                    onClick={() => {
                        if (platform === item.key) return;
                        setPlatform(item.key);
                        setDetail(null);
                    }}
                >
                    <span className="lx-platform-mark" style={{ background: item.color }}>{item.label.slice(0, 1)}</span>
                    {item.label}
                </Button>
            ))}
        </div>
    ) : null;

    const renderCard = (collection: ProviderCollection) => {
        const count = formatCount(collection.playCount);
        const meta = [collection.creator?.nickname, formatDate(collection.updatedAt)].filter(Boolean).join(' · ');
        return (
            <Button type="button" key={String(collection.id)} className="lx-card" onClick={() => openPlaylistCard(collection)}>
                <div className="lx-cover">
                    {collection.coverUrl
                        ? <img src={collection.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : <span>{collection.name.slice(0, 1)}</span>}
                    {count ? <span className="lx-cover-count"><Play size={9} />{count}</span> : null}
                </div>
                <div className="lx-card-title">{collection.name}</div>
                {meta ? <div className="lx-card-meta">{meta}</div> : null}
            </Button>
        );
    };

    const renderProgram = (program: LxApiRadioProgram) => (
        <Button
            type="button"
            key={program.id}
            className="lx-card"
            onClick={() => handlePlay(lxBrowse.toSong(program.song))}
        >
            <div className="lx-cover">
                {program.coverUrl
                    ? <img src={program.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    : <span>{program.name.slice(0, 1)}</span>}
                <span className="lx-cover-count">电台</span>
            </div>
            <div className="lx-card-title">{program.name}</div>
            {program.djName ? <div className="lx-card-meta">{program.djName}</div> : null}
        </Button>
    );

    /** 空状态按「这一页 × 这一家」说清楚，别拿同一句话糊过去。 */
    const emptyText = (): string => {
        if (tab === 'radio') {
            return platform === 'wy'
                ? '网易云暂时没返回电台节目。'
                : `${platformBadge(platform).label}没有公开的电台接口，换到网易云看看。`;
        }
        if (tab === 'album') {
            return platform === 'wy' || platform === 'kg'
                ? '这家暂时没返回新碟，稍后再试。'
                : `${platformBadge(platform).label}没有公开的新碟列表，换到网易云或酷狗看看。`;
        }
        return '这个平台暂时没有返回歌单，换一家看看。';
    };

    const renderBrowseTab = () => {
        if (detail) {
            return (
                <>
                    <div className="lx-detail-head">
                        <div className="lx-cover lx-detail-cover">
                            {detail.coverUrl
                                ? <img src={detail.coverUrl} alt="" referrerPolicy="no-referrer" />
                                : <span>{detail.title.slice(0, 1)}</span>}
                        </div>
                        <div className="lx-detail-text">
                            <div className="lx-detail-kind">
                                {detail.kind === 'album' ? '专辑' : '歌单'} · {platformBadge(detail.platform).label}
                            </div>
                            <div className="lx-detail-title">{detail.title}</div>
                            <div className="lx-detail-sub">{detail.subtitle || `${detailSongs.length} 首`}</div>
                        </div>
                    </div>
                    <div className="lx-detail-actions">
                        <Button
                            type="button"
                            className="lx-btn lx-btn-play"
                            disabled={detailSongs.length === 0}
                            onClick={() => {
                                const [first, ...rest] = detailSongs;
                                rest.forEach((song) => onAddToQueue(song));
                                if (first) handlePlay(first);
                            }}
                        >
                            <Play size={13} fill="currentColor" />播放全部
                        </Button>
                        <Button type="button" className="lx-btn-ghost" onClick={() => setDetail(null)}>返回列表</Button>
                    </div>
                    {!canPlayOn(detail.platform) ? (
                        <div className="lx-notice" data-kind="warn">
                            还没有可用的音源，这些歌点开会放不出来。去右上角「音源」导入一个。
                        </div>
                    ) : null}
                    {detailError ? <div className="lx-notice" data-kind="warn">{detailError}</div> : null}
                    {detailLoading && detailSongs.length === 0 ? (
                        <p className="lx-empty">正在读取曲目…</p>
                    ) : detailSongs.length === 0 ? (
                        <p className="lx-empty">没有读到曲目。</p>
                    ) : (
                        <LxTrackList songs={detailSongs} onPlay={handlePlay} onQueue={onAddToQueue} />
                    )}
                    {detailHasMore ? (
                        <div className="lx-more">
                            <Button type="button" className="lx-btn-ghost" disabled={detailLoading} onClick={() => void loadMoreDetail()}>
                                {detailLoading ? '加载中…' : '加载更多'}
                            </Button>
                        </div>
                    ) : null}
                </>
            );
        }

        const empty = tab === 'radio' ? programs.length === 0 : collections.length === 0;
        return (
            <>
                {browseError ? <div className="lx-notice" data-kind="warn">{browseError}</div> : null}
                {browseLoading && empty ? (
                    <p className="lx-empty">正在读取{tab === 'album' ? '新碟' : tab === 'radio' ? '电台' : '歌单'}…</p>
                ) : empty ? (
                    <p className="lx-empty">{emptyText()}</p>
                ) : (
                    <div className="lx-grid">
                        {tab === 'radio' ? programs.map(renderProgram) : collections.map(renderCard)}
                    </div>
                )}
                {browseHasMore ? (
                    <div className="lx-more">
                        <Button
                            type="button"
                            className="lx-btn-ghost"
                            disabled={browseLoading}
                            onClick={() => void loadBrowse(platform, tab, browseOffset, true)}
                        >
                            {browseLoading ? '加载中…' : '加载更多'}
                        </Button>
                    </div>
                ) : null}
            </>
        );
    };

    const renderChartTab = () => {
        const activeChart = charts.find((chart) => chart.id === chartId);
        return (
            <>
                {chartError ? <div className="lx-notice" data-kind="warn">{chartError}</div> : null}
                <div className="lx-chart-layout">
                    <div className="lx-chart-rail">
                        {charts.map((chart) => (
                            <Button
                                key={chart.id}
                                type="button"
                                className="lx-chart-item"
                                data-active={chart.id === chartId}
                                onClick={() => setChartId(chart.id)}
                            >
                                {chart.name}
                            </Button>
                        ))}
                    </div>
                    <div>
                        {activeChart ? (
                            <div className="lx-chart-title">
                                {platformBadge(platform).label} · {activeChart.name}
                            </div>
                        ) : null}
                        {chartLoading && chartSongs.length === 0 ? (
                            <p className="lx-empty">正在读取榜单…</p>
                        ) : chartSongs.length === 0 ? (
                            <p className="lx-empty">这个榜暂时没有曲目。</p>
                        ) : (
                            <LxTrackList songs={chartSongs} onPlay={handlePlay} onQueue={onAddToQueue} />
                        )}
                    </div>
                </div>
            </>
        );
    };

    const renderSearchTab = () => (
        <>
            <div className="lx-search-row">
                <TextField
                    className="lx-input"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(query, false); }}
                    placeholder="搜歌名 / 歌手 / 专辑（四家一起搜）"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <Button type="button" className="lx-btn" disabled={searchLoading || !query.trim()} onClick={() => void runSearch(query, false)}>
                    {searchLoading ? '搜索中…' : '搜索'}
                </Button>
            </div>
            {searchError ? <div className="lx-notice" data-kind="warn">{searchError}</div> : null}
            {searchSongs.length === 0 ? (
                <p className="lx-empty">
                    {submittedQuery ? `没搜到「${submittedQuery}」。` : '输入关键词，网易云 / QQ / 酷狗 / 酷我的结果会一起列出来。'}
                </p>
            ) : (
                <>
                    <div className="lx-result-head">「{submittedQuery}」的结果 · {searchSongs.length} 首</div>
                    <LxTrackList songs={searchSongs} onPlay={handlePlay} onQueue={onAddToQueue} />
                </>
            )}
            {searchHasMore ? (
                <div className="lx-more">
                    <Button type="button" className="lx-btn-ghost" disabled={searchLoading} onClick={() => void runSearch(submittedQuery, true)}>
                        {searchLoading ? '加载中…' : '加载更多'}
                    </Button>
                </div>
            ) : null}
        </>
    );

    const renderLocalTab = () => (
        <div className="lx-blank">
            <Search size={26} strokeWidth={1.4} />
            <p className="lx-blank-title">本地音乐不在这儿</p>
            <p className="lx-blank-text">
                洛雪的「本地」读的是手机里的音频文件；这个 App 的本地曲库在自己那一页。
                这里先留个说明，等本地扫描接进洛雪再补上。
            </p>
            <Button type="button" className="lx-btn-ghost" onClick={onClose}>回到 Folia</Button>
        </div>
    );

    return (
        <div
            className="lx-root"
            data-daylight={isDaylight ? 'true' : 'false'}
            style={{
                color: theme.primaryColor,
                '--lx-accent': theme.accentColor || '#e11d48',
            } as React.CSSProperties}
            role="dialog"
            aria-modal="true"
            aria-label="洛雪"
        >
            <header className="lx-header">
                <div className="lx-head-bar">
                    <Button type="button" className="lx-icon-btn" onClick={onClose} aria-label="关闭洛雪">
                        <ArrowLeft size={18} />
                    </Button>
                    <div className="lx-head-title">
                        <span className="lx-brand">洛雪</span>
                        <span className="lx-brand-sub">LX MUSIC</span>
                    </div>
                    <div style={{ flex: '1 1 auto' }} />
                    <Button
                        type="button"
                        className="lx-source-btn"
                        data-active={tab === 'source'}
                        onClick={() => setTab('source')}
                        aria-label="音源"
                    >
                        <Plus size={13} />
                        音源{sourceCount > 0 ? <b>{sourceCount}</b> : null}
                    </Button>
                    <Button
                        type="button"
                        className="lx-icon-btn"
                        aria-label="刷新"
                        title="刷新"
                        onClick={() => {
                            setDetail(null);
                            setRefreshTick((prev) => prev + 1);
                        }}
                    >
                        <RefreshCw size={15} />
                    </Button>
                </div>

                <nav className="lx-seg" aria-label="洛雪页签">
                    {PILLS.map((item) => (
                        <Button
                            key={item.key}
                            type="button"
                            className="lx-seg-item"
                            data-active={tab === item.key}
                            onClick={() => {
                                if (tab === item.key) return;
                                setDetail(null);
                                setTab(item.key);
                            }}
                        >
                            {item.label}
                        </Button>
                    ))}
                </nav>

                {platformRow}
            </header>

            <div className="lx-body">
                {tab === 'playlist' || tab === 'album' || tab === 'radio' ? renderBrowseTab() : null}
                {tab === 'chart' ? renderChartTab() : null}
                {tab === 'search' ? renderSearchTab() : null}
                {tab === 'local' ? renderLocalTab() : null}
                {tab === 'source' ? <LxSourcePanel onChanged={handleSourceChanged} /> : null}
            </div>

            {playHint ? <div className="lx-toast" role="status">{playHint}</div> : null}
        </div>
    );
};

export default LxWorkspace;
