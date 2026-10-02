import React from 'react';
import type { RowComponentProps } from 'react-window';
import type { SongResult } from '../../../types';
import { isSongUnavailable } from '../../../services/onlineMusic/songAvailability';
import { getSongArtistLabel } from '../../../services/onlineMusic/songMetadata';
import { formatTime } from '../../../utils/appPlaybackHelpers';

// src/library/suites/tui/LibraryTuiRow.tsx
// TUI 的一行：序号、歌名、歌手、专辑、时长，等宽排列。单击移动焦点，双击播放，[+] 入队。

export const LIBRARY_TUI_ROW_HEIGHT = 28;

export type LibraryTuiRowProps = {
    tracks: SongResult[];
    rowDisplayIndexes: number[];
    /** 每行的条目键（与网格卡片 id 同一格式）。 */
    rowKeys: string[];
    focusedRow: number;
    accentBackground: string;
    accentColor: string;
    enqueueLabel: string;
    unavailableLabel: string;
    onFocusRow: (row: number) => void;
    onPlayRow: (row: number) => void;
    onEnqueueRow: (row: number) => void;
};

const cell = 'truncate whitespace-pre';

const LibraryTuiRow = ({
    index,
    style,
    tracks,
    rowDisplayIndexes,
    rowKeys,
    focusedRow,
    accentBackground,
    accentColor,
    enqueueLabel,
    unavailableLabel,
    onFocusRow,
    onPlayRow,
    onEnqueueRow,
}: RowComponentProps<LibraryTuiRowProps>): React.ReactElement | null => {
    const displayIndex = rowDisplayIndexes[index];
    const track = displayIndex === undefined ? undefined : tracks[displayIndex];
    if (!track) return null;

    const isFocused = index === focusedRow;
    const unavailable = isSongUnavailable(track);
    return (
        <div
            role="option"
            aria-selected={isFocused}
            data-tui-row={index}
            data-library-entry={rowKeys[index]}
            style={{
                ...style,
                backgroundColor: isFocused ? accentBackground : undefined,
                opacity: unavailable ? 0.45 : undefined,
            }}
            onClick={() => onFocusRow(index)}
            onDoubleClick={() => onPlayRow(index)}
            className="grid cursor-default select-none grid-cols-[2ch_6ch_minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_6ch_4ch] items-center gap-x-3 px-4 text-[13px]"
        >
            <span style={{ color: isFocused ? accentColor : undefined }}>{isFocused ? '>' : ' '}</span>
            <span className="tabular-nums opacity-50">{String(displayIndex + 1).padStart(4, '0')}</span>
            <span className={cell}>
                {track.name}
                {unavailable ? <span className="opacity-70">{`  (${unavailableLabel})`}</span> : null}
            </span>
            <span className={`${cell} opacity-70`}>{getSongArtistLabel(track)}</span>
            <span className={`${cell} opacity-55`}>{track.album?.name || ''}</span>
            <span className="tabular-nums opacity-55">{formatTime((track.durationMs || 0) / 1000)}</span>
            <button
                type="button"
                title={enqueueLabel}
                aria-label={enqueueLabel}
                onClick={(event) => {
                    event.stopPropagation();
                    onEnqueueRow(index);
                }}
                className="opacity-50 hover:opacity-100 disabled:opacity-20"
                disabled={unavailable}
            >
                [+]
            </button>
        </div>
    );
};

export default LibraryTuiRow;
