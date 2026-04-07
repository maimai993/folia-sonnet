import React, { useState } from 'react';
import { MotionValue, useMotionValueEvent } from 'framer-motion';

export interface DevDebugLineSnapshot {
    text: string | null;
    translation: string | null;
    wordCount: number | null;
    startTime: number | null;
    endTime: number | null;
    renderEndTime: number | null;
    rawDuration: number | null;
    timingClass: string | null;
    lineTransitionMode: string | null;
    wordRevealMode: string | null;
}

export interface DevDebugSnapshot {
    shortcutLabel: string;
    currentView: string;
    playerState: string;
    visualizerMode: string;
    songName: string | null;
    songSource: string;
    lyricsSource: string;
    audioSrcKind: string;
    duration: number;
    currentLineIndex: number;
    totalLines: number;
    activeLine: DevDebugLineSnapshot | null;
    nextLine: DevDebugLineSnapshot | null;
}

interface DevDebugOverlayProps {
    snapshot: DevDebugSnapshot;
    currentTime: MotionValue<number>;
    isDaylight: boolean;
}

const formatSeconds = (value: number | null | undefined) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return 'N/A';
    }

    return `${value.toFixed(3)}s`;
};

const formatClock = (value: number) => {
    if (!Number.isFinite(value) || value < 0) {
        return '00:00';
    }

    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const DebugRow: React.FC<{ label: string; value: string; }> = ({ label, value }) => {
    return (
        <>
            <dt className="text-[10px] uppercase tracking-[0.16em] opacity-60">{label}</dt>
            <dd className="text-[11px] font-medium text-right break-words">{value}</dd>
        </>
    );
};

const DebugLineBlock: React.FC<{ label: string; line: DevDebugLineSnapshot | null; }> = ({ label, line }) => {
    if (!line) {
        return (
            <section className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">{label}</div>
                <div className="mt-1 text-[11px] font-medium">N/A</div>
            </section>
        );
    }

    return (
        <section className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">{label}</div>
            <div className="mt-1 text-[11px] font-medium whitespace-pre-wrap break-words">
                {line.text || 'N/A'}
            </div>
            {line.translation ? (
                <div className="mt-1 text-[10px] opacity-70 whitespace-pre-wrap break-words">
                    {line.translation}
                </div>
            ) : null}
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                <DebugRow label="words" value={line.wordCount === null ? 'N/A' : String(line.wordCount)} />
                <DebugRow label="start" value={formatSeconds(line.startTime)} />
                <DebugRow label="end" value={formatSeconds(line.endTime)} />
                <DebugRow label="renderEnd" value={formatSeconds(line.renderEndTime)} />
                <DebugRow label="raw" value={formatSeconds(line.rawDuration)} />
                <DebugRow label="timing" value={line.timingClass ?? 'N/A'} />
                <DebugRow label="transition" value={line.lineTransitionMode ?? 'N/A'} />
                <DebugRow label="reveal" value={line.wordRevealMode ?? 'N/A'} />
            </dl>
        </section>
    );
};

const DevDebugOverlay: React.FC<DevDebugOverlayProps> = ({
    snapshot,
    currentTime,
    isDaylight,
}) => {
    const [liveCurrentTime, setLiveCurrentTime] = useState(() => currentTime.get());

    useMotionValueEvent(currentTime, 'change', latest => {
        setLiveCurrentTime(latest);
    });

    const shellClass = isDaylight
        ? 'bg-white/76 text-zinc-900 border border-black/10 shadow-[0_18px_60px_rgba(0,0,0,0.14)]'
        : 'bg-black/58 text-white border border-white/10 shadow-[0_18px_60px_rgba(0,0,0,0.32)]';

    return (
        <aside className="pointer-events-none fixed top-4 right-4 z-[65] w-[min(30rem,calc(100vw-2rem))]">
            <div
                className={`pointer-events-auto max-h-[calc(100vh-2rem)] overflow-y-auto overscroll-contain rounded-2xl backdrop-blur-2xl px-4 py-3 font-mono ${shellClass}`}
            >
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.24em] opacity-60">Dev Lyrics Debug</div>
                        <div className="mt-1 text-sm font-semibold break-words">{snapshot.songName || 'No Track'}</div>
                    </div>
                    <div className="text-[10px] opacity-70 whitespace-nowrap">{snapshot.shortcutLabel}</div>
                </div>

                <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                    <DebugRow label="view" value={snapshot.currentView} />
                    <DebugRow label="player" value={snapshot.playerState} />
                    <DebugRow label="renderer" value={snapshot.visualizerMode} />
                    <DebugRow
                        label="time"
                        value={`${formatClock(liveCurrentTime)} / ${formatClock(snapshot.duration)} (${formatSeconds(liveCurrentTime)})`}
                    />
                    <DebugRow label="songSource" value={snapshot.songSource} />
                    <DebugRow label="lyricsSource" value={snapshot.lyricsSource} />
                    <DebugRow label="audioSrc" value={snapshot.audioSrcKind} />
                    <DebugRow label="lineIndex" value={String(snapshot.currentLineIndex)} />
                    <DebugRow label="lineCount" value={String(snapshot.totalLines)} />
                </dl>

                <div className="mt-3 grid gap-2">
                    <DebugLineBlock label="Current Line" line={snapshot.activeLine} />
                    <DebugLineBlock label="Next Line" line={snapshot.nextLine} />
                </div>
            </div>
        </aside>
    );
};

export default DevDebugOverlay;
