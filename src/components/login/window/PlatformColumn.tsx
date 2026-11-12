import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Search } from 'lucide-react';
import type { OnlineProviderId, ProviderAccountSummary } from '../../../types/onlineMusic';
import { providerDisplayName } from '../../../i18n/providerName';
import { Tooltip } from '../../modal/settings/kit';
import { AccountPicture, PlatformMark, platformMarkOf } from '../PlatformMark';
import { rowStatus, type RowStatus } from '../platformRows';
import { filterRows } from './loginView';
import { countMergeableProviders } from '../../../library/core/collection/onlineProviderScope';
import {
    ALL_PROVIDERS_ID,
    selectIsAllProvidersScope,
    useLibraryOnlineProviderScopeStore,
} from '../../../library/core/directory/useLibraryOnlineProviderScopeStore';

// src/components/login/window/PlatformColumn.tsx
// 登录窗口里平台的那一列：每个平台一行（记号、名字和它下面的登录状态、已登录的头像），各行平分列的高，
// 选中的行左边有一道平台的颜色。一块高亮跟着指针和方向键在行
// 之间滑。点一行或者在高亮的行上按回车才是选中；方向键只移动高亮，不开始登录。够不着的平台是灰的，
// 不能选，悬停时说原因。从 12 个平台起上面有搜索框。窗口窄的时候它横在窗口上面，成一排。

/** 从这么多个平台起有搜索框。 */
const SEARCH_FROM = 12;

/**
 * 竖着的那一列里一行的高：平台们平分列的高，每行在 46 到 68 之间。平台少时行到 68 就不再长，下面留空；
 * 多到挤不下 46 就滚。
 */
const ROW_SIZE = 'min-h-[46px] max-h-[68px] flex-[1_1_0]';

type Box = { x: number; y: number; w: number; h: number };

/**
 * 一行在列表内容里的位置和大小，带小数。不用 offset*：它们取整，各行平分列高时最后一行取整后的底边
 * 可能比列表多 1px，高亮块就把列表撑出滚动条；滚动条让行变窄、溢出消失，再量又变回去，
 * 来回不停到 React 报更新层数超限（#913）。getBoundingClientRect 带着祖先的缩放（窗口打开时的动画），
 * 所以用行的布局高度把缩放除掉。行没排版（display: none、jsdom）时布局高度是 auto，就不除。
 */
const measureRow = (list: HTMLElement, row: HTMLElement): Box => {
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const height = parseFloat(getComputedStyle(row).height);
    const scale = height > 0 && rowRect.height > 0 ? rowRect.height / height : 1;
    return {
        x: (rowRect.left - listRect.left) / scale - list.clientLeft + list.scrollLeft,
        y: (rowRect.top - listRect.top) / scale - list.clientTop + list.scrollTop,
        w: rowRect.width / scale,
        h: rowRect.height / scale,
    };
};

/** 量出来的数差不到 0.01px 算没变：除掉缩放的那一下有浮点误差。 */
const sameBox = (a: Box | null, b: Box | null): boolean => (
    a === b || (a !== null && b !== null && [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h].every(d => Math.abs(d) < 0.01))
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
    const text = status === 'checking' ? t('login.rowChecking') : status === 'ran-out' ? t('login.rowRanOut')
        : status === 'accountless' ? t('home.providerNoAccount')
            : status === 'off' ? t(row.availability.messageKey ?? 'home.providerNotConfigured') : t('login.rowSignedOut');
    return (
        <span className={`truncate text-[11.5px] leading-4 ${status === 'ran-out' ? 'text-[color:var(--st-warn)]' : 'text-[color:var(--st-t3)]'}`}>{text}</span>
    );
};

type PlatformColumnProps = {
    /** 排好顺序的平台。 */
    rows: ProviderAccountSummary[];
    chosenId: OnlineProviderId | null;
    onChoose: (provider: ProviderAccountSummary) => void;
    /*
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
    const shown = rows.length >= SEARCH_FROM ? filterRows(rows, query, row => providerDisplayName(t, row)) : rows;
    /*
     * 最上面那一行「全部」：给了回调才画，而且要有两家以上真有歌单可合 —— 只有一家时
     * 它与直接选那一家没有区别，多一行只是多一处要认的地方。
     */
    const mergeableCount = countMergeableProviders(rows);
    const showAll = Boolean(onAllProvidersChosen) && mergeableCount >= 2;
    const allScope = useLibraryOnlineProviderScopeStore(selectIsAllProvidersScope);
    const setScope = useLibraryOnlineProviderScopeStore(state => state.selectScope);
    // 高亮在哪一行：指针或方向键指着的；都没有指着就是选中的那一行。
    const [pointed, setPointed] = useState<OnlineProviderId | null>(null);
    const pointedRow = pointed ? shown.find(row => row.providerId === pointed) ?? null : null;
    /*
     * 指针没有指着别处、而「全部」正开着：高亮落在它那一行上。选中的那一行仍然是当前平台
     * （它左边那道颜色还留在那儿）—— 这两件事不是一回事：一个是「登录着谁」，一个是「首页看谁的数据」。
     */
    const litAll = showAll && (pointed === ALL_PROVIDERS_ID || (pointed === null && allScope));
    const lit = pointedRow ?? (litAll ? null : shown.find(row => row.providerId === chosenId) ?? null);
    const listRef = useRef<HTMLDivElement>(null);
    // 高亮那一块自己。它的位置和大小不进 React state —— 见下面 placeGlow 的说明。
    const glowRef = useRef<HTMLDivElement>(null);
    // 上一次摆在那一块上的数；拿来和这次量的比，一样的就不动笔。
    const glowBox = useRef<Box | null>(null);
    // 列表的哪一头后面还有行：那一头淡出。
    const [more, setMore] = useState({ before: false, after: false });
    // 高亮这一块此刻量哪一行（「全部」也占一行的 id，好让 rowOf 一样找得到它）。
    const highlightId = lit?.providerId ?? (litAll ? ALL_PROVIDERS_ID : null);
    const rowOf = (providerId: string | null | undefined) => (
        providerId ? listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(providerId)}"]`) ?? null : null
    );

    /*
     * 把高亮那一块摆到它那一行的位置上。
     *
     * 为什么不记在 React state 里：位置和大小是从自己的 DOM 上量的，而「量 → 写 state →
     * 重渲染 → 再量」是一个圈 —— 那个 effect 又跟着每次渲染都跑，于是它自己把自己转起来，
     * 转起来就没有尽头（平板上点进汽水登录时整屏黑在那儿）。这个圈与量出来的数变没变无关：
     * 哪怕每次量到的都一样，React 也要为这一次更新再渲染一遍这一层。所以量完直接写在那一块
     * 的 style 上，不经过 React：state 少一样东西，这个圈就断了。
     *
     * 直接写 style 之后，每次渲染仍然会量一遍（行的宽跟着名字、头像和语言变，只能量）；
     * 但量到的数没变就不动笔，不动笔就不会逼浏览器重画。
     */
    const placeGlow = () => {
        const glow = glowRef.current;
        if (!glow) return;
        const list = listRef.current;
        const row = rowOf(highlightId);
        if (!list || !row) {
            if (glowBox.current === null) return;
            glowBox.current = null;
            glow.style.opacity = '0';
            return;
        }
        const next = measureRow(list, row);
        if (sameBox(glowBox.current, next)) return;
        glowBox.current = next;
        glow.style.width = `${next.w}px`;
        glow.style.height = `${next.h}px`;
        glow.style.transform = `translate(${next.x}px, ${next.y}px)`;
        glow.style.opacity = '1';
    };

    // 高亮那一块的位置和大小，每次画完从它所在的行量一遍（行的宽度跟着名字、头像和语言变）；数没变就不动。
    useLayoutEffect(placeGlow);

    // 选中的行换了，把它滚进来。指针指着的行不滚：列表不在指针底下自己动，指针移开也不跳回去。
    useLayoutEffect(() => {
        rowOf(chosenId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [chosenId, lie]);

    const readMore = () => {
        const list = listRef.current;
        if (!list) return;
        const [at, room, all] = lie === 'column' ? [list.scrollTop, list.clientHeight, list.scrollHeight] : [list.scrollLeft, list.clientWidth, list.scrollWidth];
        const next = { before: at > 1, after: at + room < all - 1 };
        setMore(current => (current.before === next.before && current.after === next.after ? current : next));
    };
    // 行数变了、横竖换了，和列表自己的大小变了（窗口变宽变窄）的时候都重看一遍。
    useEffect(() => {
        readMore();
        const list = listRef.current;
        if (!list || typeof ResizeObserver === 'undefined') return undefined;
        // 列表自己变了大小时，那一块也要跟着摆一次：这不是渲染引起的，没人替它再量一遍。
        const observer = new ResizeObserver(() => { placeGlow(); readMore(); });
        observer.observe(list);
        return () => observer.disconnect();
    }, [shown.length, lie]);

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
        const reachable: string[] = [
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
    const stateText = (status: ReturnType<typeof rowStatus>, messageKey?: string): string | null => (
        status === 'checking' ? t('login.rowChecking') : status === 'signed-in' ? t('login.rowSignedIn') : status === 'ran-out' ? t('login.rowRanOut') : status === 'off' ? t(messageKey ?? 'home.providerNotConfigured') : null
    );

    return (
        <div className={`flex min-h-0 min-w-0 ${lie === 'column' ? 'h-full w-full flex-col' : 'flex-col'}`}>
            {rows.length >= SEARCH_FROM && (
                <label className="st-t-fast mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[var(--st-fill)] px-2.5 text-[color:var(--st-t3)] transition-shadow focus-within:shadow-[inset_0_0_0_1.5px_var(--st-line2)]">
                    <Search size={14} className="shrink-0" />
                    <input
                        value={query}
                        onChange={event => { setQuery(event.target.value); setPointed(null); }}
                        onKeyDown={handleKeyDown}
                        placeholder={t('login.searchPlatforms')}
                        aria-label={t('login.searchPlatforms')}
                        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[color:var(--st-t1)] outline-none placeholder:text-[color:var(--st-t3)]"
                    />
                </label>
            )}
            <div
                ref={listRef}
                role="listbox"
                tabIndex={0}
                aria-label={t('home.onlineProvider')}
                aria-activedescendant={highlightId ? `login-row-${highlightId}` : undefined}
                onKeyDown={handleKeyDown}
                onScroll={readMore}
                onMouseLeave={() => setPointed(null)}
                className={`relative min-h-0 rounded-lg outline-none ${lie === 'column' ? 'st-scroll flex flex-1 flex-col overflow-y-auto overscroll-contain' : 'login-row-scroll flex gap-1 overflow-x-auto overscroll-x-contain'}`}
                style={fade ? { WebkitMaskImage: fade, maskImage: fade } : undefined}
            >
                {/*
                    高亮那一块：位置和大小由 placeGlow 直接写在它身上（不经过 React），
                    这里只给个起始的不透明度，写死的内容不会再被 React 动。
                */}
                <div
                    ref={glowRef}
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
                        className={`st-t-fast relative flex cursor-pointer items-center rounded-lg transition-colors ${lie === 'column' ? `${ROW_SIZE} w-full gap-3 px-2.5` : 'h-9 max-w-[168px] shrink-0 gap-2.5 px-2'} ${allScope || pointed === ALL_PROVIDERS_ID ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)]'}`}
                    >
                        {/* 开着的时候左边这一道和平台那一行那道一个意思：此刻在看的就是它。 */}
                        {lie === 'column' && (
                            <i
                                aria-hidden
                                className={`st-t-fast absolute left-0 top-1/2 h-[38%] w-[3px] -translate-y-1/2 rounded-full transition-opacity ${allScope ? 'opacity-100' : 'opacity-0'}`}
                                style={{ background: 'var(--st-t2)' }}
                            />
                        )}
                        <span
                            aria-hidden
                            className="inline-grid shrink-0 place-items-center rounded-full bg-[var(--st-fill2)] text-[color:var(--st-t1)]"
                            style={{ width: lie === 'column' ? 30 : 22, height: lie === 'column' ? 30 : 22 }}
                        >
                            <Layers size={lie === 'column' ? 16 : 14} />
                        </span>
                        {lie === 'column' ? (
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
                    const state = stateText(status, row.availability.messageKey);
                    const name = providerDisplayName(t, row);
                    const chosen = row.providerId === chosenId;
                    const bright = chosen || row.providerId === lit?.providerId;
                    const tall = lie === 'column';
                    const item = (
                        <div
                            id={`login-row-${row.providerId}`}
                            data-row={row.providerId}
                            role="option"
                            // 黄点和头像是画出来的：读屏的人从这一句知道这一行是已登录、登录失效还是不能选。
                            aria-label={state ? `${name} · ${state}` : undefined}
                            aria-selected={chosen}
                            aria-disabled={status === 'off' || undefined}
                            aria-busy={status === 'checking' || undefined}
                            onMouseEnter={() => { if (status !== 'off') setPointed(row.providerId); }}
                            onClick={() => { if (canChoose(row)) onChoose(row); }}
                            className={`st-t-fast relative flex items-center rounded-lg transition-colors ${tall ? `${ROW_SIZE} w-full gap-3 px-2.5` : 'h-9 max-w-[168px] shrink-0 gap-2.5 px-2'} ${status === 'off' ? 'cursor-default opacity-[0.42]' : 'cursor-pointer'} ${bright ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)]'}`}
                        >
                            {/* 选中的那一行左边一道平台的颜色：高亮跟着指针走，这一道留在选中的行上。 */}
                            {tall && (
                                <i
                                    aria-hidden
                                    className={`st-t-fast absolute left-0 top-1/2 h-[38%] w-[3px] -translate-y-1/2 rounded-full transition-opacity ${chosen ? 'opacity-100' : 'opacity-0'}`}
                                    style={{ background: platformMarkOf(row.providerId, name).color }}
                                />
                            )}
                            <PlatformMark providerId={row.providerId} label={name} size={tall ? 30 : 22} ranOut={status === 'ran-out'} />
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
                        ? <Tooltip key={row.providerId} text={t('home.providerNotConfigured')} className={tall ? `flex ${ROW_SIZE}` : 'shrink-0'}>{item}</Tooltip>
                        : <React.Fragment key={row.providerId}>{item}</React.Fragment>;
                })}
                {shown.length === 0 && (
                    <p className="py-6 text-center text-[13px] text-[color:var(--st-t3)]">{t('login.noPlatformMatch')}</p>
                )}
            </div>
        </div>
    );
};

export default PlatformColumn;
