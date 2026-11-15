import React from 'react';
import { List, useListRef, type RowComponentProps } from 'react-window';
import { ListEnd, ListMusic, ListPlus, NotebookPen, PanelsTopLeft, Shuffle, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SongResult } from '../../types';
import TextInputDialog from '../shared/TextInputDialog';
import { Button } from '../modal/settings/kit';
import { useKitReducedMotion } from '../modal/settings/kit/motion';
import { getSongTag, isSongUnavailable } from '../../services/onlineMusic/songAvailability';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { queueIndexOfKey } from '../../utils/playbackNeighbors';
import { EmptyState } from './shell/EmptyState';
import { PanelIconButton } from './shell/PanelIconButton';
import { useIsWideShortViewport } from './shell/panelViewport';

// src/components/panelTab/QueueTab.tsx
// The panel's queue tab: a line with the number of songs and the queue's own buttons, then the
// queue as a list that scrolls inside itself. The list is as tall as its rows, seven and a half
// of them at most, and lower where the window leaves less (--pn-tab-room, from the panel's frame);
// while more rows follow it fades at the bottom. A row plays its song; its three actions show
// under the pointer and when the keyboard reaches them.
//
// 矮而宽（横过来的手机）时**一排摆两首**（见 panelViewport / ControlsTab 的两栏）：那种窗口
// 纵向只放得下三四行，单列一屏看不了几首；横向面板已经摊到 560px，一排两个半行正好把
// 宽度用掉、可见数量翻一倍。两首并排时次序是「先左后右、再往下一行」，滚动和定位都按
// **显示行**算，行内的两个下标各自换算回歌在队列里的真下标。

const ROW_PX = 48;
/** The line above the list. */
const HEAD_PX = 36;
/** Seven and a half rows: the half row says that more follow. */
const LIST_MAX_PX = 7.5 * ROW_PX;
/** The list fades over this much of its bottom while more rows follow. */
const FADE = 'linear-gradient(#000 calc(100% - 32px), transparent)';

interface QueueTabProps {
    playQueue: SongResult[];
    currentSong: SongResult | null;
    onPlaySong: (song: SongResult, queue: SongResult[]) => void;
    queueScrollRef: React.RefObject<HTMLDivElement | null>;
    shouldScrollToCurrent?: boolean;
    onShuffle?: () => void;
    onRemoveSong: (index: number) => void;
    onMoveSongToEnd: (index: number) => void;
    onMoveSongToNext: (index: number) => void;
    canSaveLocalPlaylist?: boolean;
    /** Opens the same queue as a poster wall; absent when the host has no wall to show. */
    onOpenLattice?: () => void;
    /** 在速记簿里展开队列（打开速记簿的播放队列页、展开成画布）。 */
    onOpenScratchpadQueue?: () => void;
    onSaveCurrentQueueAsPlaylist?: (name: string) => Promise<void>;
    isDaylight?: boolean;
}

type QueueRowProps = {
    playQueue: SongResult[];
    currentSongKey: string | null;
    /** 一排摆几首：矮而宽时是 2（见文件头注释），平时是 1。 */
    columns: number;
    onPlaySong: QueueTabProps['onPlaySong'];
    onMoveSongToNext: QueueTabProps['onMoveSongToNext'];
    onMoveSongToEnd: QueueTabProps['onMoveSongToEnd'];
    onRemoveSong: QueueTabProps['onRemoveSong'];
    labels: {
        unavailable: string;
        video: string;
        playNext: string;
        moveToEnd: string;
        remove: string;
    };
};

/** 一首队列条目：原来整行的样子，现在是一排里的一格（下标是它在队列里的真下标）。 */
const QueueCell = ({
    song,
    songIndex,
    playQueue,
    currentSongKey,
    onPlaySong,
    onMoveSongToNext,
    onMoveSongToEnd,
    onRemoveSong,
    labels,
}: {
    song: SongResult;
    songIndex: number;
    playQueue: SongResult[];
    currentSongKey: string | null;
    onPlaySong: QueueTabProps['onPlaySong'];
    onMoveSongToNext: QueueTabProps['onMoveSongToNext'];
    onMoveSongToEnd: QueueTabProps['onMoveSongToEnd'];
    onRemoveSong: QueueTabProps['onRemoveSong'];
    labels: QueueRowProps['labels'];
}) => {
    const isActive = currentSongKey === getPlaybackSongKey(song);
    const isUnavailable = isSongUnavailable(song);
    const tag = getSongTag(song, labels);

    return (
        <div
            onClick={() => onPlaySong(song, playQueue)}
            data-active={isActive}
            className={`st-t-fast group relative flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-lg pl-3 pr-1.5 transition-colors ${isActive ? 'bg-[var(--st-fill)]' : 'hover:bg-[var(--st-fill)] focus-within:bg-[var(--st-fill)]'}`}
        >
            {isActive && <span aria-hidden className="absolute inset-y-3.5 left-0 w-[3px] rounded-r-sm bg-[var(--st-accent)]" />}
            <div className={`min-w-0 flex-1 ${isUnavailable ? 'opacity-55' : ''}`}>
                <div className="flex items-center gap-2 text-[13px] leading-[19px]">
                    <span className={`truncate ${isActive ? 'font-semibold' : ''}`}>{song.name}</span>
                    {tag && (
                        <span className="shrink-0 rounded bg-[var(--st-fill2)] px-[5px] py-px text-[11px] leading-[15px] text-[color:var(--st-t2)]">
                            {tag}
                        </span>
                    )}
                </div>
                <div className="truncate text-xs leading-[17px] text-[color:var(--st-t3)]">{getSongArtistLabel(song)}</div>
            </div>
            {/* No width until the pointer or the keyboard is on the row, so a long name has the whole row. Tab changes the panel's tab, so the keyboard does not walk into a row: the actions are the pointer's, as before. */}
            <div className="st-t-fast flex w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-opacity group-focus-within:ml-2 group-focus-within:w-auto group-focus-within:opacity-100 group-hover:ml-2 group-hover:w-auto group-hover:opacity-100">
                {[
                    { label: labels.playNext, icon: ListPlus, action: onMoveSongToNext },
                    { label: labels.moveToEnd, icon: ListEnd, action: onMoveSongToEnd },
                    { label: labels.remove, icon: Trash2, action: onRemoveSong },
                ].map(({ label, icon: Icon, action }) => (
                    <PanelIconButton
                        key={label}
                        size="s"
                        label={label}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (event.detail > 0) {
                                event.currentTarget.blur();
                            }
                            action(songIndex);
                        }}
                    >
                        <Icon size={15} />
                    </PanelIconButton>
                ))}
            </div>
        </div>
    );
};

// Kept outside QueueTab so track changes update row data without remounting hovered action buttons.
const QueueRow = ({
    index,
    style,
    ariaAttributes,
    playQueue,
    columns,
    currentSongKey,
    onPlaySong,
    onMoveSongToNext,
    onMoveSongToEnd,
    onRemoveSong,
    labels,
}: RowComponentProps<QueueRowProps>): React.ReactElement => {
    const cells = Array.from({ length: columns }, (_, cell) => {
        const songIndex = index * columns + cell;
        const song = playQueue[songIndex];
        if (!song) return <div key={cell} className="min-w-0 flex-1" />;
        return (
            <QueueCell
                key={songIndex}
                song={song}
                songIndex={songIndex}
                playQueue={playQueue}
                currentSongKey={currentSongKey}
                onPlaySong={onPlaySong}
                onMoveSongToNext={onMoveSongToNext}
                onMoveSongToEnd={onMoveSongToEnd}
                onRemoveSong={onRemoveSong}
                labels={labels}
            />
        );
    });
    // 一排一首时不套那层 flex/间距：跟原来的单层结构一个样，免得为不存在的第二格平添包装。
    if (columns === 1) {
        return <div style={style} {...ariaAttributes}>{cells}</div>;
    }
    return (
        <div style={style} {...ariaAttributes} className="flex items-stretch gap-2">
            {cells}
        </div>
    );
};

const QueueTab: React.FC<QueueTabProps> = ({
    playQueue,
    currentSong,
    onPlaySong,
    queueScrollRef,
    shouldScrollToCurrent = false,
    onShuffle,
    onRemoveSong,
    onMoveSongToEnd,
    onMoveSongToNext,
    canSaveLocalPlaylist = false,
    onOpenLattice,
    onOpenScratchpadQueue,
    onSaveCurrentQueueAsPlaylist,
    isDaylight = false,
}) => {
    const { t } = useTranslation();
    const reduced = useKitReducedMotion();
    const currentSongKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    // 矮而宽时一排两首（见文件头注释）；列数变了显示行数跟着变，高度和滚动都按显示行算。
    const columns = useIsWideShortViewport() ? 2 : 1;
    const rowCount = Math.ceil(playQueue.length / columns);
    // As tall as its rows up to the most it shows; never under two rows, so in a very low window
    // the tab scrolls instead.
    const rowsPx = Math.min(rowCount * ROW_PX, LIST_MAX_PX);
    const listHeight = `clamp(${Math.min(rowsPx, 2 * ROW_PX)}px, calc(var(--pn-tab-room, 100vh) - ${HEAD_PX}px), ${rowsPx}px)`;

    const listRef = useListRef(null);
    const isInitialMountRef = React.useRef(true);
    const lastScrolledIndexRef = React.useRef<number>(-1);
    const wasOpenRef = React.useRef(false);
    const [isSaveDialogOpen, setIsSaveDialogOpen] = React.useState(false);
    const [hasMoreBelow, setHasMoreBelow] = React.useState(false);
    const rowProps = React.useMemo<QueueRowProps>(() => ({
        playQueue,
        columns,
        currentSongKey,
        onPlaySong,
        onMoveSongToNext,
        onMoveSongToEnd,
        onRemoveSong,
        labels: {
            unavailable: t('status.songUnavailableTag'),
            video: t('status.songVideoTag'),
            playNext: t('queue.playNext'),
            moveToEnd: t('queue.moveToEnd'),
            remove: t('queue.remove'),
        },
    }), [
        columns,
        currentSongKey,
        onMoveSongToEnd,
        onMoveSongToNext,
        onPlaySong,
        onRemoveSong,
        playQueue,
        t,
    ]);

    // Whether rows follow under what the list shows: read before the first frame is drawn, and
    // when the list scrolls, changes size or length. On the first frame the list's handle has no
    // element yet; the list is the one child of the element around it.
    const readHasMoreBelow = React.useCallback(() => {
        const list = listRef.current?.element ?? queueScrollRef.current?.firstElementChild;
        if (list) {
            setHasMoreBelow(list.scrollHeight - list.scrollTop - list.clientHeight > 4);
        }
    }, [listRef, queueScrollRef]);
    React.useLayoutEffect(readHasMoreBelow, [rowCount, readHasMoreBelow]);

    // Reset initial mount state when panel is opened
    React.useEffect(() => {
        if (shouldScrollToCurrent && !wasOpenRef.current) {
            isInitialMountRef.current = true;
            wasOpenRef.current = true;
        } else if (!shouldScrollToCurrent) {
            wasOpenRef.current = false;
        }
    }, [shouldScrollToCurrent]);

    // Auto-scroll to current song
    React.useEffect(() => {
        if (shouldScrollToCurrent && currentSongKey && listRef.current) {
            const currentIndex = queueIndexOfKey(playQueue, currentSongKey);
            if (currentIndex >= 0) {
                const isInitialMount = isInitialMountRef.current;
                const songChanged = lastScrolledIndexRef.current !== currentIndex && lastScrolledIndexRef.current !== -1;

                const behavior = (isInitialMount || !songChanged || reduced) ? 'instant' : 'smooth';
                const delay = isInitialMount ? 0 : 50;

                setTimeout(() => {
                    if (listRef.current) {
                        // The row before the playing one goes to the top: the rows line up with
                        // the list's top edge, and what was just played stays in view.
                        // 一排两首时列表的「行」是显示行，先换算回去再定位。
                        listRef.current.scrollToRow({
                            index: Math.max(0, Math.floor((currentIndex - 1) / columns)),
                            align: 'start',
                            behavior: behavior as 'instant' | 'smooth'
                        });
                        lastScrolledIndexRef.current = currentIndex;
                        isInitialMountRef.current = false;
                    }
                }, delay);
            }
        }
    }, [shouldScrollToCurrent, columns, currentSongKey, playQueue, listRef, reduced]);

    const handleSavePlaylist = async () => {
        if (!onSaveCurrentQueueAsPlaylist) {
            return;
        }
        setIsSaveDialogOpen(true);
    };

    if (playQueue.length === 0) {
        return <EmptyState icon={<ListMusic size={28} />}>{t('queue.empty')}</EmptyState>;
    }

    return (
        <>
            <div className="select-none">
                <div className="flex items-center gap-0.5 pb-1 pl-1" style={{ height: HEAD_PX }}>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-[color:var(--st-t2)]">
                        {t('queue.title')}
                        <span className="ml-1.5 font-normal text-[color:var(--st-t3)]">{playQueue.length}</span>
                    </span>
                    {canSaveLocalPlaylist && (
                        <Button variant="quiet" onClick={handleSavePlaylist}>
                            {t('localMusic.saveQueueAsPlaylist')}
                        </Button>
                    )}
                    {onOpenScratchpadQueue && (
                        <PanelIconButton size="s" label={t('scratchpad.openQueueCanvas')} onClick={onOpenScratchpadQueue}>
                            <NotebookPen size={15} />
                        </PanelIconButton>
                    )}
                    {onOpenLattice && (
                        <PanelIconButton size="s" label={t('home.lattice')} onClick={onOpenLattice}>
                            <PanelsTopLeft size={15} />
                        </PanelIconButton>
                    )}
                    {onShuffle && (
                        <PanelIconButton size="s" label={t('queue.shuffle')} onClick={onShuffle}>
                            <Shuffle size={15} />
                        </PanelIconButton>
                    )}
                </div>

                <div ref={queueScrollRef}>
                    <List
                        listRef={listRef}
                        rowCount={rowCount}
                        rowHeight={ROW_PX}
                        // The list measures itself after its first frame; until then it takes this height, so that frame has all its rows.
                        defaultHeight={rowsPx}
                        rowComponent={QueueRow}
                        rowProps={rowProps}
                        overscanCount={5}
                        onScroll={readHasMoreBelow}
                        onResize={readHasMoreBelow}
                        className="st-scroll"
                        style={{ height: listHeight, width: '100%', maskImage: hasMoreBelow ? FADE : undefined }}
                    />
                </div>
            </div>

            <TextInputDialog
                isOpen={isSaveDialogOpen}
                onClose={() => setIsSaveDialogOpen(false)}
                isDaylight={isDaylight}
                title={t('localMusic.saveQueueAsPlaylist')}
                placeholder={t('localMusic.enterPlaylistName')}
                confirmLabel={t('localMusic.save')}
                onConfirm={async (playlistName) => {
                    try {
                        await onSaveCurrentQueueAsPlaylist?.(playlistName);
                    } catch (error) {
                        console.error('Failed to save local playlist', error);
                    }
                }}
            />
        </>
    );
};

export default QueueTab;
