// src/components/app/video/VideoWorkspace.tsx
// 影视工作台：一份 TVBox 配置里的站点，分类条 + 海报流 + 搜索，点开是线路与选集。
//
// 关于「能跑什么」：配置里的站点分两类——type 0/1 走标准 HTTP 接口，本机直接请求；
// type 3/4 要跑配置自带的 spider 包（ARM 程序），本机加载不了。所以这里只把前一类做成
// 可浏览可播放，后一类在状态行里如实标出来，不假装能点。
//
// 搜索不在这里另开一个输入框：工作台是覆盖层，顶栏那颗搜索框还在，用户在顶栏打字（停一下或回车）
// 就直接搜影视；这里只显示「正在搜什么」和一条回推荐流的退路。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Grid3DSlider, type Grid3DSliderItem } from '../../../library/suites/grid/home/Grid3DSlider';
import { useVideoSettingsStore } from '../../../stores/useVideoSettingsStore';
import { VideoPlayer, type VideoEpisode } from './VideoPlayer';
import {
    browseSite,
    classifySites,
    detailCms,
    loadVideoConfig,
    parsePlayLines,
    resolveSites,
    searchVideosInSites,
    type CmsPlayLine,
    type CmsVideo,
    type SiteAvailability,
    type VideoConfig,
    type VideoSearchHit,
    type VideoSite,
} from '../../../services/videoSources';

// 影视页的状态：正在加载、加载失败、可用。
// 可用态里同时带着「这份配置里哪些站点能用」和「实际要浏览的站点」——两者不一定相同：
// 配置里一个能跑的都没有时（整份配置都是内置 spider），实际浏览的会是内置源，fallback 标出这件事。
type LoadState =
    | { stage: 'loading' }
    | { stage: 'error'; message: string }
    | {
        stage: 'ready';
        config: VideoConfig | null;
        sites: SiteAvailability[];
        usable: VideoSite[];
        fallback: boolean;
        /** 配置没读成、退回内置源时，把原因留在这儿给底下那行小字。 */
        note?: string;
    };

// 打开哪一屏：配置里可用站点的海报流，还是一次聚合搜索的结果。
type ViewMode = { kind: 'browse' } | { kind: 'search'; keyword: string };

/** 顶部一条状态行：配置里的站点、能用几个、以及在用内置源这件事。 */
const SiteSummary: React.FC<{ sites: SiteAvailability[]; usableCount: number; fallback: boolean; configured: boolean; note?: string }> = ({
    sites,
    usableCount,
    fallback,
    configured,
    note,
}) => {
    const blocked = sites.filter(item => !item.usable).length;
    const firstBlocked = sites.find(item => !item.usable);
    return (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[12.5px] leading-5 text-[color:var(--st-t3)]">
            {note && <span className="text-[color:var(--st-warn)]">{note}</span>}
            {!configured && <span>没填配置地址，正在用内置源。</span>}
            {configured && !note && fallback && (
                <span className="text-[color:var(--st-warn)]">
                    {`这份配置的 ${sites.length} 个站点全部是内置 spider，本机跑不了，已切到内置源（${usableCount} 个）。`}
                </span>
            )}
            {configured && !fallback && (
                <span>{`共 ${sites.length} 个站点，其中 ${usableCount} 个可直接使用`}</span>
            )}
            {blocked > 0 && (
                <span className="text-[color:var(--st-warn)]">
                    {`${blocked} 个需要配置自带的 spider，本机不支持`}
                </span>
            )}
        </div>
    );
};

/**
 * 一张海报：照首页封面卡片的做法——整块深色圆角卡，封面嵌在里面，下面左边是标题，再下面一行灰的副标题。
 * 不用裸图 + 悬停小标题那种，那样一屏里全是图，剧名读不出来。
 */
const PosterCard: React.FC<{ video: CmsVideo; onOpen: () => void }> = ({ video, onOpen }) => {
    const subtitle = video.remarks
        || [video.typeName, video.year, video.area].filter(Boolean).join(' · ')
        || '影视';
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group flex w-full min-w-0 flex-col items-stretch overflow-hidden rounded-2xl bg-[#141418] p-2 text-left transition-colors hover:bg-[#1c1c22]"
            title={video.name}
        >
            <span className="relative block w-full aspect-[2/3] overflow-hidden rounded-xl bg-white/5">
                {video.pic ? (
                    <img
                        src={video.pic}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                ) : (
                    <span className="flex h-full w-full items-center justify-center text-[12px] text-[#f2f2f4]/35">无封面</span>
                )}
                {video.remarks && (
                    <span className="absolute bottom-1 left-1 max-w-[calc(100%-8px)] truncate rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
                        {video.remarks}
                    </span>
                )}
            </span>
            <span className="mt-2 block truncate px-1 text-[13px] font-semibold leading-[18px] text-[#f2f2f4]">{video.name}</span>
            <span className="mb-1 mt-0.5 block truncate px-1 text-[11.5px] leading-4 text-[#f2f2f4]/45">{subtitle}</span>
        </button>
    );
};

/** 选集面板。线路用页签切换，集用官方那条 3D 卡片流——每集借剧集海报当封面，左右滑着挑。 */
const EpisodePanel: React.FC<{
    video: CmsVideo;
    onClose: () => void;
    onPlay: (lines: CmsPlayLine[], lineIndex: number, index: number) => void;
}> = ({ video, onClose, onPlay }) => {
    const lines: CmsPlayLine[] = useMemo(() => parsePlayLines(video), [video]);
    const [lineIndex, setLineIndex] = useState(0);
    const [epFocus, setEpFocus] = useState(0);
    const line = lines[Math.min(lineIndex, lines.length - 1)];
    const episodesList = line?.episodes ?? [];

    if (lines.length === 0) {
        return (
            <div className="rounded-xl border border-white/10 bg-[#17171b] p-4 text-[13px] text-[color:var(--st-t2)] shadow-2xl">
                <div className="mb-2 font-medium text-[color:var(--st-t1)]">{video.name}</div>
                这个站点没有给出可解析的播放地址。
                <button type="button" onClick={onClose} className="mt-3 block text-[color:var(--st-accent)]">返回</button>
            </div>
        );
    }

    return (
        <div className="flex h-[min(82vh,660px)] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#17171b] shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-3 px-4 pt-3">
                <div className="min-w-0">
                    <div className="truncate text-[15px] font-semibold text-[color:var(--st-t1)]">{video.name}</div>
                    <div className="mt-0.5 truncate text-[12.5px] text-[color:var(--st-t3)]">
                        {[video.typeName, video.year, video.area].filter(Boolean).join(' · ')}
                    </div>
                </div>
                <button type="button" onClick={onClose} className="shrink-0 text-[13px] text-[color:var(--st-t2)] hover:text-[color:var(--st-t1)]">
                    关闭
                </button>
            </div>

            {lines.length > 1 && (
                <div className="flex shrink-0 flex-wrap justify-center gap-1.5 px-4 pt-2">
                    {lines.map((item, index) => (
                        <button
                            key={`${item.name}-${index}`}
                            type="button"
                            onClick={() => { setLineIndex(index); setEpFocus(0); }}
                            className={`rounded-md px-2.5 py-1 text-[12.5px] ${index === lineIndex ? 'bg-white/20 text-[color:var(--st-t1)]' : 'text-[color:var(--st-t3)] hover:text-[color:var(--st-t2)]'}`}
                        >
                            {item.name}
                        </button>
                    ))}
                </div>
            )}

            <div className="min-h-0 flex-1">
                {episodesList.length === 0 ? (
                    <p className="py-10 text-center text-[13px] text-[color:var(--st-t3)]">这条线路没有集数</p>
                ) : (
                    <Grid3DSlider
                        items={episodesList.map((episode, index) => ({
                            id: `${index}-${episode.name}`,
                            name: episode.name || `第 ${index + 1} 集`,
                            coverUrl: video.pic,
                            description: `第 ${index + 1} 集`,
                            type: 'video',
                        }))}
                        focusedIndex={Math.min(epFocus, episodesList.length - 1)}
                        onFocusedIndexChange={setEpFocus}
                        onSelect={(_item: Grid3DSliderItem, index: number) => {
                            onPlay(lines, Math.min(lineIndex, lines.length - 1), index);
                        }}
                        isDaylight={false}
                        hasFloatingPlayer={false}
                        openOnAnyCardClick
                    />
                )}
            </div>

            <p className="shrink-0 px-4 pb-3 pt-1 text-center text-[12px] leading-5 text-[color:var(--st-t3)]">
                左右滑着挑，点中间那张就在 Folia 里播（m3u8 走 hls.js）。
            </p>
        </div>
    );
};

export const VideoWorkspace: React.FC = () => {
    const videoSourceUrl = useVideoSettingsStore(state => state.videoSourceUrl);
    const [state, setState] = useState<LoadState>({ stage: 'loading' });
    const [mode, setMode] = useState<ViewMode>({ kind: 'browse' });
    const [activeSiteKey, setActiveSiteKey] = useState('');
    const [categoryId, setCategoryId] = useState('');
    const [videos, setVideos] = useState<CmsVideo[]>([]);
    const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
    const [browseBusy, setBrowseBusy] = useState(false);
    const [browseError, setBrowseError] = useState('');
    const [searchHits, setSearchHits] = useState<VideoSearchHit[]>([]);
    const [searchNote, setSearchNote] = useState('');
    const [searchBusy, setSearchBusy] = useState(false);
    const [openVideo, setOpenVideo] = useState<CmsVideo | null>(null);
    /** 「全部平台」的范围：'all' 汇总所有源，否则只用一个源。 */
    const [scope, setScope] = useState('all');
    const [scopeOpen, setScopeOpen] = useState(false);
    /** 官方 3D 卡片流的焦点：左右滑动靠它，换列表时归零。 */
    const [focusIndex, setFocusIndex] = useState(0);
    const [playing, setPlaying] = useState<{
        title: string;
        cover?: string;
        lines: CmsPlayLine[];
        lineIndex: number;
        episodes: VideoEpisode[];
        index: number;
    } | null>(null);

    // 有地址就拉配置；没填地址也进来，直接用内置源——这样打开就能看到片，不必先有配置。
    // 同一地址不重复请求。
    useEffect(() => {
        if (!videoSourceUrl) {
            const builtin = resolveSites(null);
            setState({ stage: 'ready', config: null, sites: [], usable: builtin.sites, fallback: true });
            setActiveSiteKey(builtin.sites[0]?.key ?? '');
            setCategoryId('');
            return;
        }
        let cancelled = false;
        setState({ stage: 'loading' });
        loadVideoConfig(videoSourceUrl)
            .then(config => {
                if (cancelled) return;
                const sites = classifySites(config);
                const resolved = resolveSites(config);
                setState({ stage: 'ready', config, sites, usable: resolved.sites, fallback: resolved.fallback });
                setActiveSiteKey(resolved.sites[0]?.key ?? '');
                setCategoryId('');
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                // 配置没读成也别把页面顶死：先退回内置源，把原因留给底下那行小字。
                const builtin = resolveSites(null);
                if (builtin.sites.length > 0) {
                    setState({
                        stage: 'ready',
                        config: null,
                        sites: [],
                        usable: builtin.sites,
                        fallback: true,
                        note: `配置读取失败（${error instanceof Error ? error.message : String(error)}），已先退回内置源。`,
                    });
                    setActiveSiteKey(builtin.sites[0]?.key ?? '');
                    setCategoryId('');
                    return;
                }
                setState({ stage: 'error', message: error instanceof Error ? error.message : String(error) });
            });
        return () => { cancelled = true; };
    }, [videoSourceUrl]);

    const usableSites: VideoSite[] = useMemo(
        () => (state.stage === 'ready' ? state.usable : []),
        [state],
    );
    const fallback = state.stage === 'ready' ? state.fallback : false;
    const activeSite = usableSites.find(site => site.key === activeSiteKey);

    // 换站点 / 换分类就重新拉一页列表。
    const loadBrowse = useCallback(async (site: VideoSite, nextCategory: string) => {
        setBrowseBusy(true);
        setBrowseError('');
        try {
            const result = await browseSite(site, { categoryId: nextCategory || undefined, page: 1 });
            setVideos(result.videos);
            if (result.categories.length > 0) setCategories(result.categories);
        } catch (error) {
            setVideos([]);
            setBrowseError(error instanceof Error ? error.message : String(error));
        } finally {
            setBrowseBusy(false);
        }
    }, []);

    useEffect(() => {
        if (mode.kind !== 'browse' || !activeSite) return;
        void loadBrowse(activeSite, categoryId);
    }, [activeSite, categoryId, loadBrowse, mode.kind]);

    // 站点列表要给顶栏搜索用；存一份 ref，免得事件回调里读到旧闭包。
    const usableRef = useRef<VideoSite[]>([]);
    useEffect(() => { usableRef.current = usableSites; }, [usableSites]);

    const runSearch = useCallback(async (word: string) => {
        if (!word || usableRef.current.length === 0) return;
        // 「全部平台」就全搜；选中某个源就只搜那一个。
        const targets = scope === 'all'
            ? usableRef.current
            : usableRef.current.filter(site => site.key === scope);
        if (targets.length === 0) return;
        setSearchBusy(true);
        setSearchNote('');
        setSearchHits([]);
        setMode({ kind: 'search', keyword: word });
        try {
            const result = await searchVideosInSites(targets, word);
            setSearchHits(result.hits);
            if (result.siteCount === 0) {
                setSearchNote('没有可直接搜索的站点。');
            } else if (result.hits.length === 0) {
                const reasons = result.failures.map(item => `${item.siteName}：${item.message}`).join('；');
                setSearchNote(reasons ? `没有搜到。${reasons}` : '没有搜到。');
            } else if (result.failures.length > 0) {
                setSearchNote(result.failures.map(item => `${item.siteName} 未返回`).join('，'));
            }
        } catch (error) {
            setSearchNote(error instanceof Error ? error.message : String(error));
        } finally {
            setSearchBusy(false);
        }
    }, [scope]);

    /**
     * 顶上那颗搜索框就是影视的搜索框：工作台是覆盖层，顶栏还在。这里监听那颗 input——
     * 停手 0.9 秒或者按回车就去搜影视。input 可能因为换页签换 placeholder 而被重新挂载，
     * 所以隔一会儿重新认一次元素。
     */
    const [topWord, setTopWord] = useState('');
    useEffect(() => {
        let attached: HTMLInputElement | null = null;
        let settle = 0;
        const pickTopInput = (): HTMLInputElement | null => {
            const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
            return inputs.find(input => {
                if (input.type !== 'text' && input.type !== 'search') return false;
                const box = input.getBoundingClientRect();
                return box.width > 120 && box.height > 10 && box.top < 100;
            }) ?? null;
        };
        const onInput = () => {
            const value = attached?.value ?? '';
            setTopWord(value);
            window.clearTimeout(settle);
            const word = value.trim();
            if (!word) return;
            settle = window.setTimeout(() => { void runSearch(word); }, 900);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            // 顶栏那颗搜索框同时也是 Folia 自己的：不拦下来，回车就会被它拿去跳音乐搜索页。
            // 在 document 捕获阶段先吃掉，只让影视的搜索接手。
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            const word = attached?.value?.trim() ?? '';
            if (!word) return;
            window.clearTimeout(settle);
            void runSearch(word);
        };
        const bind = () => {
            const next = pickTopInput();
            if (next === attached) return;
            if (attached) {
                attached.removeEventListener('input', onInput);
            }
            attached = next;
            if (attached) {
                attached.addEventListener('input', onInput);
            }
        };
        bind();
        document.addEventListener('keydown', onKeyDown, true);
        const timer = window.setInterval(bind, 800);
        return () => {
            window.clearInterval(timer);
            window.clearTimeout(settle);
            document.removeEventListener('keydown', onKeyDown, true);
            if (attached) {
                attached.removeEventListener('input', onInput);
            }
        };
    }, [runSearch]);

    const openDetail = useCallback(async (siteKey: string, video: CmsVideo) => {
        // 列表里拿到的通常是摘要，播放地址要再取一次详情。
        const site = usableSites.find(item => item.key === siteKey);
        if (!site || !video.id) { setOpenVideo(video); return; }
        try {
            const [detail] = await detailCms(site.api, [video.id]);
            setOpenVideo(detail ?? video);
        } catch {
            setOpenVideo(video);
        }
    }, [usableSites]);

    if (state.stage === 'loading') {
        return <div className="flex h-full items-center justify-center text-[13px] text-[color:var(--st-t3)]">正在读取配置…</div>;
    }

    if (state.stage === 'error') {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <h2 className="text-[15px] font-semibold text-[color:var(--st-t1)]">配置读取失败</h2>
                <p className="max-w-[460px] break-words text-[13px] leading-6 text-[color:var(--st-t2)]">{state.message}</p>
                <p className="text-[12px] text-[color:var(--st-t3)]">到「设置 → 连接与集成 → 影视」换一个地址再回来。</p>
            </div>
        );
    }

    // 一集正在播就整页让给播放器，返回键回到选集。
    if (playing) {
        return (
            <VideoPlayer
                title={playing.title}
                cover={playing.cover}
                lines={playing.lines}
                lineIndex={playing.lineIndex}
                episodes={playing.lines[playing.lineIndex]?.episodes ?? playing.episodes}
                index={playing.index}
                onIndexChange={next => setPlaying(current => (current ? { ...current, index: next } : current))}
                onLineChange={next => setPlaying(current => (current ? { ...current, lineIndex: next, index: 0 } : current))}
                onClose={() => setPlaying(null)}
            />
        );
    }

    const scopeLabel = scope === 'all'
        ? '全部平台'
        : usableSites.find(site => site.key === scope)?.name ?? '全部平台';

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            {/* 「● 全部平台 ⌄」：位置和形态照首页那一颗，选全部就搜所有源，选一个就只搜那一个。 */}
            <div className="relative flex shrink-0 items-center justify-center">
                <button
                    type="button"
                    onClick={() => setScopeOpen(open => !open)}
                    className="flex h-7 items-center gap-1.5 rounded-full border-y border-white/[0.12] bg-black/45 px-3 text-[12.5px] font-medium text-[color:var(--st-t1)] outline outline-1 outline-[rgba(40,40,40,0.2)] backdrop-blur transition-colors hover:bg-black/65"
                >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#56c98d]" />
                    <span className="whitespace-nowrap">{scopeLabel}</span>
                    <ChevronDown size={13} />
                </button>
                {scopeOpen && (
                    <>
                        <button
                            type="button"
                            aria-hidden="true"
                            tabIndex={-1}
                            onClick={() => setScopeOpen(false)}
                            className="fixed inset-0 z-40 cursor-default"
                        />
                        <div className="absolute top-8 z-50 max-h-[60vh] w-[230px] overflow-y-auto rounded-xl border border-white/[0.12] bg-[#17171b] p-1 shadow-2xl">
                            <button
                                type="button"
                                onClick={() => {
                                    setScope('all');
                                    setScopeOpen(false);
                                }}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/[0.08] ${scope === 'all' ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)]'}`}
                            >
                                <span className="whitespace-nowrap">全部平台</span>
                                <span className="shrink-0 text-[11px] text-[color:var(--st-t3)]">{usableSites.length} 个源</span>
                            </button>
                            <div className="my-1 h-px bg-white/[0.08]" />
                            {usableSites.map(site => (
                                <button
                                    key={site.key}
                                    type="button"
                                    onClick={() => {
                                        setScope(site.key);
                                        setActiveSiteKey(site.key);
                                        setCategoryId('');
                                        setCategories([]);
                                        setVideos([]);
                                        setMode({ kind: 'browse' });
                                        setSearchHits([]);
                                        setSearchNote('');
                                        setScopeOpen(false);
                                    }}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/[0.08] ${scope === site.key ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)]'}`}
                                >
                                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${scope === site.key ? 'bg-[#56c98d]' : 'bg-white/25'}`} />
                                    <span className="min-w-0 flex-1 truncate">{site.name}</span>
                                </button>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {(mode.kind === 'search' || searchBusy) && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-[13px] text-[color:var(--st-t2)]">
                        {searchBusy
                            ? `正在搜「${mode.kind === 'search' ? mode.keyword : topWord}」…`
                            : `影视搜索结果 · 「${mode.kind === 'search' ? mode.keyword : ''}」${searchHits.length} 条`}
                    </span>
                    <button
                        type="button"
                        onClick={() => { setMode({ kind: 'browse' }); setSearchHits([]); setSearchNote(''); }}
                        className="h-7 shrink-0 rounded-lg bg-white/10 px-2.5 text-[12.5px] text-[color:var(--st-t2)] hover:bg-white/20 hover:text-[color:var(--st-t1)]"
                    >
                        返回推荐
                    </button>
                </div>
            )}

            {mode.kind === 'search' ? (
                <div className="flex min-h-0 flex-1 flex-col">
                    {searchNote && <p className="mb-1 shrink-0 text-[12.5px] leading-5 text-[color:var(--st-warn)]">{searchNote}</p>}
                    {searchBusy && searchHits.length === 0 ? (
                        <p className="py-8 text-center text-[13px] text-[color:var(--st-t3)]">正在搜…</p>
                    ) : searchHits.length === 0 ? (
                        <p className="py-8 text-center text-[13px] text-[color:var(--st-t3)]">没有结果</p>
                    ) : (
                        <div className="min-h-0 flex-1">
                            <Grid3DSlider
                                items={searchHits.map(hit => ({
                                    id: `${hit.siteKey}-${hit.id}`,
                                    name: hit.name,
                                    coverUrl: hit.pic,
                                    description: hit.remarks || [hit.typeName, hit.year, hit.area].filter(Boolean).join(' · ') || '影视',
                                    type: 'video',
                                }))}
                                focusedIndex={focusIndex}
                                onFocusedIndexChange={setFocusIndex}
                                onSelect={(_item: Grid3DSliderItem, index: number) => {
                                    const hit = searchHits[index];
                                    if (hit) void openDetail(hit.siteKey, hit);
                                }}
                                isDaylight={false}
                                hasFloatingPlayer={false}
                                openOnAnyCardClick
                            />
                        </div>
                    )}
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                    {categories.length > 0 && (
                        <div className="flex shrink-0 flex-wrap justify-center gap-1.5">
                            {[{ id: '', name: '全部' }, ...categories].map(item => (
                                <button
                                    key={item.id || 'all'}
                                    type="button"
                                    onClick={() => setCategoryId(item.id)}
                                    className={`rounded-md px-2.5 py-1 text-[12.5px] ${item.id === categoryId ? 'bg-[var(--st-fill2)] text-[color:var(--st-t1)]' : 'text-[color:var(--st-t3)] hover:text-[color:var(--st-t2)]'}`}
                                >
                                    {item.name}
                                </button>
                            ))}
                        </div>
                    )}

                    {browseError && <p className="shrink-0 text-center text-[12.5px] text-[color:var(--st-warn)]">{browseError}</p>}

                    <div className="min-h-0 flex-1">
                        {browseBusy && videos.length === 0 ? (
                            <p className="py-8 text-center text-[13px] text-[color:var(--st-t3)]">正在取列表…</p>
                        ) : videos.length === 0 ? (
                            <p className="py-8 text-center text-[13px] text-[color:var(--st-t3)]">这个站点没有返回列表</p>
                        ) : (
                            <Grid3DSlider
                                items={videos.map(video => ({
                                    id: video.id,
                                    name: video.name,
                                    coverUrl: video.pic,
                                    description: video.remarks || [video.typeName, video.year, video.area].filter(Boolean).join(' · ') || '影视',
                                    type: 'video',
                                }))}
                                focusedIndex={focusIndex}
                                onFocusedIndexChange={setFocusIndex}
                                onSelect={(_item: Grid3DSliderItem, index: number) => {
                                    const video = videos[index];
                                    if (video) void openDetail(activeSite?.key ?? '', video);
                                }}
                                isDaylight={false}
                                hasFloatingPlayer={false}
                                openOnAnyCardClick
                            />
                        )}
                    </div>
                </div>
            )}

            {/* 站点状态挪到最下面一行：上面留给卡片流，一行小字在底下交代「共几个源、哪些跑不了」。 */}
            <div className="flex shrink-0 justify-center pb-0.5">
                <SiteSummary
                    sites={state.sites}
                    usableCount={usableSites.length}
                    fallback={fallback}
                    note={state.note}
                    configured={Boolean(videoSourceUrl)}
                />
            </div>

            {openVideo && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" onClick={() => setOpenVideo(null)}>
                    <div className="w-full max-w-[1000px]" onClick={event => event.stopPropagation()}>
                        <EpisodePanel
                            video={openVideo}
                            onClose={() => setOpenVideo(null)}
                            onPlay={(playLines, playLineIndex, index) => {
                                setPlaying({
                                    title: openVideo.name,
                                    cover: openVideo.pic,
                                    lines: playLines,
                                    lineIndex: playLineIndex,
                                    episodes: playLines[playLineIndex]?.episodes ?? [],
                                    index,
                                });
                                setOpenVideo(null);
                            }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};

export default VideoWorkspace;
