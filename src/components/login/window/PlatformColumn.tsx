import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Search } from 'lucide-react';
import type { OnlineProviderId, ProviderAccountSummary } from '../../../types/onlineMusic';
import { countMergeableProviders } from '../../../library/core/collection/onlineProviderScope';
import {
    ALL_PROVIDERS_ID,
    selectIsAllProvidersScope,
    useLibraryOnlineProviderScopeStore,
} from '../../../library/core/directory/useLibraryOnlineProviderScopeStore';
import { Tooltip } from '../../modal/settings/kit';
import { AccountPicture, PlatformMark, platformMarkOf } from '../PlatformMark';
import { rowStatus, type RowStatus } from '../platformRows';
import { filterRows } from './loginView';
import { TextField } from '../../ui';

// src/components/login/window/PlatformColumn.tsx
// 登录窗口里平台的那一列：每个平台一行（记号、名字和它下面的登录状态、已登录的头像），各行平分列的高，
// 选中的行左边有一道平台的颜色。一块高亮跟着指针和方向键在行
// 之间滑。点一行或者在高亮的行上按回车才是选中；方向键只移动高亮，不开始登录。够不着的平台是灰的，
// 不能选，悬停时说原因。从 12 个平台起上面有搜索框。窗口窄的时候它横在窗口上面，成一排。
//
// 最上面还有一行「全部」：它不是一家平台，是首页在线那一屏「看谁的数据」的范围（合起来看各家已登录平台
// 的歌单），两家以上真有歌单可合时才出现；再点一次回到「跟着当前平台」。点它不开始任何登录。

/** 从这么多个平台起有搜索框。 */
const SEARCH_FROM = 12;

/**
 * 竖着的那一列里一行的高：平台们平分列的高，每行在 46 到 68 之间。平台少时行到 68 就不再长，下面留空；
 * 多到挤不下 46 就滚。
 */
const ROW_SIZE = 'min-h-[46px] max-h-[68px] flex-[1_1_0]';

/**
 * 置灰那一行说的原因。三种，各说各的：
 *
 * - 「还没完全支持」：路是通的、协议没走全。说成「未配置」会让人以为填个地址就能用，
 *   说成「仅桌面端」又与事实相反 —— 桌面端之外**正是**它本来要去的那一端。
 * - 「仅桌面端」：这台机器跑不起来（`runtime-unavailable`），那几家要走桌面端那座桥的
 *   平台在安卓上就是这个状态。
 * - 「未配置 API」：剩下那种，真的只是没填地址。
 */
const offTextKey = (row: ProviderAccountSummary): string => (
    row.availability.canSignIn === false ? 'home.providerNotReady'
        : row.availability.reason === 'runtime-unavailable' ? 'home.providerDesktopOnly'
            : 'home.providerNotConfigured'
);

/** 竖着的一行名字下面那一句：登录着的是谁，或者这个平台此刻的状态。 */
const RowNote: React.FC<{ row: ProviderAccountSummary; status: RowStatus }> = ({ row, status }) => {
    const { t } = useTranslation();
    if (status === 'signed-in') {
        return (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-[color:var(--st-t3)]">
                <i aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--st-ok)]" />
                <span className="truncate">{row.user?.nickname || t('login.rowSignedIn')}</span>
            </span>
        );
    }
    const text = status === 'ran-out' ? t('login.rowRanOut')
        : status === 'accountless' ? t('home.providerNoAccount')
            : status === 'off' ? t(offTextKey(row)) : t('login.rowSignedOut');
    return (
        <span className={`truncate text-[11.5px] leading-4 ${status === 'ran-out' ? 'text-[color:var(--st-warn)]' : 'text-[color:var(--st-t3)]'}`}>{text}</span>
    );
};

type PlatformColumnProps = {
    /** 排好顺序的平台。 */
    rows: ProviderAccountSummary[];
    chosenId: OnlineProviderId | null;
    onChoose: (provider: ProviderAccountSummary) => void;
    /**
     * 点了最上面那一行「全部」之后要做的事（范围已经切好了，这里通常只是关窗 —— 好去看合并后的首页）。
     * 不给就不画这一行。
     */
    onAllProvidersChosen?: () => void;
    /** 'row'：横着一排，左右滚。 */
    lie: 'column' | 'row';
};

export const PlatformColumn: React.FC<PlatformColumnProps> = ({ rows, chosenId, onChoose, onAllProvidersChosen, lie }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const shown = rows.length >= SEARCH_FROM ? filterRows(rows, query) : rows;
    /*
     * 最上面那一行「全部」：给了回调才画，而且要有两家以上真有歌单可合 —— 只有一家时
     * 它与直接选那一家没有区别，多一行只是多一处要认的地方。
     */
    const mergeableCount = countMergeableProviders(rows);
    const showAll = Boolean(onAllProvidersChosen) && mergeableCount >= 2;
    const allScope = useLibraryOnlineProviderScopeStore(selectIsAllProvidersScope);
    const setScope = useLibraryOnlineProviderScopeStore(state => state.selectScope);
    // 高亮在哪一行：指针或方向键指着的；都没有指着就是选中的那一行。
    const [pointed, setPointed] = useState<string | null>(null);
    const pointedRow = pointed ? shown.find(row => row.providerId === pointed) ?? null : null;
    /*
     * 指针没有指着别处、而「全部」正开着：高亮落在它那一行上。选中的那一行仍然是当前平台
     * （它左边那道颜色还留在那儿）—— 这两件事不是一回事：一个是「登录着谁」，一个是「首页看谁的数据」。
     */
    const litAll = showAll && (pointed === ALL_PROVIDERS_ID || (pointed === null && allScope));
    const lit = pointedRow ?? (litAll ? null : shown.find(row => row.providerId === chosenId) ?? null);
    /** 高亮这一块此刻量哪一行（「全部」也占一行的 id，好让 rowOf 一样找得到它）。 */
    const highlightId = lit?.providerId ?? (litAll ? ALL_PROVIDERS_ID : null);
    const listRef = useRef<HTMLDivElement>(null);
    const highlightRef = useRef<HTMLDivElement>(null);
    // 列表的哪一头后面还有行：那一头淡出。
    const [more, setMore] = useState({ before: false, after: false });
    const rowOf = (id: string | null | undefined) => (
        id ? listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null : null
    );

    // 高亮那一块的位置和大小，每次画完从它所在的行量一遍（行的宽度跟着名字、头像和语言变）；数没变就不动。
    // 量到的像素只画到 DOM，不再写 React state：安卓弹层进场时行的位置可能逐次变化，
    // 在无依赖的 layout effect 里 setState 会不断重画、重量，最终 React #185 把整个应用卸下。
    const paintHighlight = () => {
        const highlight = highlightRef.current;
        if (!highlight) return;
        const row = rowOf(highlightId);
        const list = listRef.current;
        const next = row && list ? {
            width: `${row.offsetWidth}px`,
            height: `${row.offsetHeight}px`,
            transform: `translate(${row.offsetLeft - list.scrollLeft}px, ${row.offsetTop - list.scrollTop}px)`,
            opacity: '1',
        } : { width: '', height: '', transform: '', opacity: '0' };
        for (const key of ['width', 'height', 'transform', 'opacity'] as const) {
            if (highlight.style[key] !== next[key]) highlight.style[key] = next[key];
        }
    };
    const paintHighlightRef = useRef(paintHighlight);
    paintHighlightRef.current = paintHighlight;
    useLayoutEffect(paintHighlight);

    // 选中的行换了，把它滚进来。指针指着的行不滚：列表不在指针底下自己动，指针移开也不跳回去。
    useLayoutEffect(() => {
        rowOf(chosenId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        paintHighlightRef.current();
    }, [chosenId, lie]);

    const readMore = () => {
        const list = listRef.current;
        if (!list) return;
        const [at, room, all] = lie === 'column' ? [list.scrollTop, list.clientHeight, list.scrollHeight] : [list.scrollLeft, list.clientWidth, list.scrollWidth];
        const next = { before: at > 1, after: at + room < all - 1 };
        setMore(current => (current.before === next.before && current.after === next.after ? current : next));
    };
    // 行数变了、横竖换了，和列表自己的大小变了（窗口变宽变窄）的时候都重看一遍。
    // 名字、头像或字体改变也可能只让一行变高；只观察列表和行，不观察自己画的高亮。
    useEffect(() => {
        const updateLayout = () => {
            paintHighlightRef.current();
            readMore();
        };
        updateLayout();
        const list = listRef.current;
        if (!list || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(updateLayout);
        observer.observe(list);
        list.querySelectorAll('[data-row]').forEach(row => observer.observe(row));
        return () => observer.disconnect();
    }, [shown, showAll, lie]);

    // 横着的那一排：竖着滚的滚轮也让它左右走（它没有滚动条）。已经到了那一头就不拦：滚轮照常去滚窗口里的内容。
    useEffect(() => {
        const list = listRef.current;
        if (!list || lie !== 'row') return undefined;
        const onWheel = (event: WheelEvent) => {
            const room = list.scrollWidth - list.clientWidth;
            if (event.deltaX !== 0 || event.deltaY === 0 || room <= 0) return;
            if (event.deltaY < 0 ? list.scrollLeft <= 0 : list.scrollLeft >= room - 1) return;
            list.scrollLeft += event.deltaY;
            event.preventDefault();
        };
        list.addEventListener('wheel', onWheel, { passive: false });
        return () => list.removeEventListener('wheel', onWheel);
    }, [lie]);

    const canChoose = (row: ProviderAccountSummary) => rowStatus(row) !== 'off';
    /** 点了「全部」：切这个范围（再点一次回到「跟着当前平台」），再让外面把窗口收了去看合并后的首页。 */
    const chooseAll = () => {
        setScope(allScope ? null : ALL_PROVIDERS_ID);
        onAllProvidersChosen?.();
    };
    const handleKeyDown = (event: React.KeyboardEvent) => {
        // 搜索框里左右键、Home、End 和空格是打字用的，不是移动高亮。
        const inField = event.target instanceof HTMLInputElement;
        // 键盘能到的行：「全部」在最前面，然后是不能选的行以外的平台。
        const reachable = [
            ...(showAll ? [ALL_PROVIDERS_ID] : []),
            ...shown.filter(canChoose).map(row => row.providerId),
        ];
        const at = highlightId ? reachable.indexOf(highlightId) : -1;
        const to = event.key === 'ArrowDown' || (!inField && event.key === 'ArrowRight') ? at + 1
            : event.key === 'ArrowUp' || (!inField && event.key === 'ArrowLeft') ? at - 1
                : inField ? null : event.key === 'Home' ? 0 : event.key === 'End' ? reachable.length - 1 : null;
        if (to !== null) {
            const next = reachable[Math.max(0, Math.min(reachable.length - 1, to))];
            if (next) {
                setPointed(next);
                // 键盘移过去的行要看得见。
                rowOf(next)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            event.preventDefault();
        } else if (event.key === 'Enter' || (!inField && event.key === ' ')) {
            const target = reachable[Math.max(0, at)];
            if (target === ALL_PROVIDERS_ID) chooseAll();
            else {
                const row = shown.find(item => item.providerId === target);
                if (row && canChoose(row)) onChoose(row);
            }
            event.preventDefault();
        }
    };

    const fade = (more.before || more.after) ? `linear-gradient(${lie === 'column' ? 'to bottom' : 'to right'}, ${more.before ? 'transparent, #000 30px' : '#000'}, ${more.after ? '#000 calc(100% - 30px), transparent' : '#000'})` : undefined;
    /** 竖着那一列里的一行：横着那一排的行是另一个样子（矮、不换行）。 */
    const tall = lie === 'column';
    const stateText = (row: ProviderAccountSummary, status: ReturnType<typeof rowStatus>): string | null => (
        status === 'signed-in' ? t('login.rowSignedIn')
            : status === 'ran-out' ? t('login.rowRanOut')
                : status === 'off' ? t(offTextKey(row))
                    : null
    );

    return (
        <div className={`flex min-h-0 min-w-0 ${lie === 'column' ? 'h-full w-full flex-col' : 'flex-col'}`}>
            {rows.length >= SEARCH_FROM && (
                <label className="st-t-fast mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[var(--st-fill)] px-2.5 text-[color:var(--st-t3)] transition-shadow focus-within:shadow-[inset_0_0_0_1.5px_var(--st-line2)]">
                    <Search size={14} className="shrink-0" />
                    <TextField
                        value={query}
                        onChange={event => { setQuery(event.target.value); setPointed(null); }}
                        onKeyDown={handleKeyDown}
                        placeholder={t('login.searchPlatforms')}
                        aria-label={t('login.searchPlatforms')}
                        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[color:var(--st-t1)] outline-none placeholder:text-[color:var(--st-t3)]"
                    />
                </label>
            )}
            <div className={`relative min-h-0 ${tall ? 'flex flex-1 flex-col' : ''}`}>
                <div
                    ref={listRef}
                    role="listbox"
                    tabIndex={0}
                    aria-label={t('home.onlineProvider')}
                    aria-activedescendant={highlightId ? `login-row-${highlightId}` : undefined}
                    onKeyDown={handleKeyDown}
                    onScroll={() => { paintHighlightRef.current(); readMore(); }}
                    onMouseLeave={() => setPointed(null)}
                    className={`relative min-h-0 rounded-lg outline-none ${lie === 'column' ? 'st-scroll flex flex-1 flex-col overflow-y-auto overscroll-contain' : 'login-row-scroll flex gap-1 overflow-x-auto overscroll-x-contain'}`}
                    style={fade ? { WebkitMaskImage: fade, maskImage: fade } : undefined}
                >
                    {/*
                        高亮那一块：位置和大小由 placeGlow 直接写在它身上（不经过 React），
                        这里只给个起始的不透明度，写死的内容不会再被 React 动。
                        它必须是列表里的第一块：量测和绘制拿它当第一块看。
                    */}
                    <div
                        ref={highlightRef}
                        aria-hidden
                        className="st-t-move pointer-events-none absolute left-0 top-0 rounded-lg bg-[var(--st-fill2)] transition-[transform,width,opacity]"
                        style={{ opacity: 0 }}
                    />
                    {showAll && (
                        <div
                            id={`login-row-${ALL_PROVIDERS_ID}`}
                            data-row={ALL_PROVIDERS_ID}
                            role="option"
                            aria-selected={allScope}
                            aria-label={t('home.allProviders')}
                            onMouseEnter={() => setPointed(ALL_PROVIDERS_ID)}
                            onClick={chooseAll}
                            className={`st-t-fast relative flex cursor-pointer items-center rounded-lg transition-colors ${tall ? `${ROW_SIZE} w-full gap-3 px-2.5` : 'h-9 max-w-[168px] shrink-0 gap-2.5 px-2'} ${allScope || pointed === ALL_PROVIDERS_ID ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)]'}`}
                        >
                            {/* 开着的时候左边这一道和平台那一行那道一个意思：此刻在看的就是它。 */}
                            {tall && (
                                <i
                                    aria-hidden
                                    className={`st-t-fast absolute left-0 top-1/2 h-[38%] w-[3px] -translate-y-1/2 rounded-full transition-opacity ${allScope ? 'opacity-100' : 'opacity-0'}`}
                                    style={{ background: 'var(--st-t2)' }}
                                />
                            )}
                            <span
                                aria-hidden
                                className="inline-grid shrink-0 place-items-center rounded-full bg-[var(--st-fill2)] text-[color:var(--st-t1)]"
                                style={{ width: tall ? 30 : 22, height: tall ? 30 : 22 }}
                            >
                                <Layers size={tall ? 16 : 14} />
                            </span>
                            {tall ? (
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate text-[13px] font-medium leading-[18px]">{t('home.allProviders')}</span>
                                    <span className="truncate text-[11.5px] leading-4 text-[color:var(--st-t3)]">
                                        {allScope ? t('home.allProvidersActive') : t('home.allProvidersDetail', { count: mergeableCount })}
                                    </span>
                                </span>
                            ) : (
                                <span className="min-w-0 flex-1 truncate text-[13px]">{t('home.allProviders')}</span>
                            )}
                        </div>
                    )}
                    {shown.map(row => {
                        const status = rowStatus(row);
                        const state = stateText(row, status);
                        const name = row.shortName || row.displayName;
                        const chosen = row.providerId === chosenId;
                        const bright = chosen || row.providerId === lit?.providerId;
                        const item = (
                            <div
                                id={`login-row-${row.providerId}`}
                                data-row={row.providerId}
                                role="option"
                                // 黄点和头像是画出来的：读屏的人从这一句知道这一行是已登录、登录失效还是不能选。
                                aria-label={state ? `${name} · ${state}` : undefined}
                                aria-selected={chosen}
                                aria-disabled={status === 'off' || undefined}
                                onMouseEnter={() => { if (status !== 'off') setPointed(row.providerId); }}
                                onClick={() => { if (status !== 'off') onChoose(row); }}
                                className={`st-t-fast relative flex items-center rounded-lg transition-colors ${tall ? `${ROW_SIZE} w-full gap-3 px-2.5` : 'h-9 max-w-[168px] shrink-0 gap-2.5 px-2'} ${status === 'off' ? 'cursor-default opacity-[0.42]' : 'cursor-pointer'} ${bright ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)]'}`}
                            >
                                {/* 选中的那一行左边一道平台的颜色：高亮跟着指针走，这一道留在选中的行上。 */}
                                {tall && (
                                    <i
                                        aria-hidden
                                        className={`st-t-fast absolute left-0 top-1/2 h-[38%] w-[3px] -translate-y-1/2 rounded-full transition-opacity ${chosen ? 'opacity-100' : 'opacity-0'}`}
                                        style={{ background: platformMarkOf(row.providerId, row.shortName).color }}
                                    />
                                )}
                                <PlatformMark providerId={row.providerId} label={row.shortName} size={tall ? 30 : 22} ranOut={status === 'ran-out'} />
                                {tall ? (
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="truncate text-[13px] font-medium leading-[18px]">{name}</span>
                                        <RowNote row={row} status={status} />
                                    </span>
                                ) : (
                                    <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
                                )}
                                {status === 'signed-in' && row.user && <AccountPicture user={row.user} size={tall ? 24 : 18} />}
                            </div>
                        );
                        return status === 'off'
                            ? <Tooltip key={row.providerId} text={t(offTextKey(row))} className={tall ? `flex ${ROW_SIZE}` : 'shrink-0'}>{item}</Tooltip>
                            : <React.Fragment key={row.providerId}>{item}</React.Fragment>;
                    })}
                    {shown.length === 0 && (
                        <p className="py-6 text-center text-[13px] text-[color:var(--st-t3)]">{t('login.noPlatformMatch')}</p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PlatformColumn;
