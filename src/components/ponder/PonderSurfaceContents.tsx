import React from 'react';
import { ChevronDown, Command, GripVertical, ListMusic, Search, Volume2 } from 'lucide-react';
import type { PonderSurfaceKind } from '../../types/ponder';

// src/components/ponder/PonderSurfaceContents.tsx
// Synthetic surfaces imitate the silhouette of the real UI without mounting live settings or
// command-palette state. Their job is recognition: a queue should read as songs, not paragraph text.

type PonderSurfaceContentsProps = {
    kind?: PonderSurfaceKind;
    accent: string;
    line: string;
    outline: string;
};

const PaletteHeader: React.FC<{ line: string; outline: string }> = ({ line, outline }) => (
    <div data-ponder-palette-header className="flex h-[22%] items-center gap-2 border-b px-[4%]" style={{ borderColor: outline }}>
        <Search className="h-[34%] w-auto opacity-50" />
        <div className="h-[24%] flex-1 rounded-full" style={{ backgroundColor: line }} />
        <div className="h-[38%] w-[9%] rounded-full border" style={{ borderColor: outline }} />
    </div>
);

const PaletteContents: React.FC<{ line: string; outline: string }> = ({ line, outline }) => (
    <div className="absolute inset-0">
        <PaletteHeader line={line} outline={outline} />
        <div className="flex h-[78%] flex-col justify-evenly px-[4%] py-[2%]">
            {[78, 92, 68].map((width, index) => (
                <div key={width} className="flex h-[27%] min-h-0 items-center gap-[3%] rounded-lg px-[2%]" style={{ backgroundColor: index === 0 ? line : undefined }}>
                    <span className="flex aspect-square h-[68%] items-center justify-center rounded-md border" style={{ borderColor: outline }}>
                        <Command className="h-1/2 w-1/2 opacity-55" />
                    </span>
                    <span className="flex flex-1 flex-col gap-1">
                        <span className="h-1.5 rounded-full" style={{ width: `${width}%`, backgroundColor: line }} />
                        <span className="h-1 rounded-full opacity-70" style={{ width: `${Math.max(42, width - 24)}%`, backgroundColor: line }} />
                    </span>
                </div>
            ))}
        </div>
    </div>
);

const PickerContents: React.FC<{ line: string; outline: string; accent: string }> = ({ line, outline, accent }) => (
    <div className="absolute inset-0 flex flex-col justify-center gap-[12%] px-[8%] py-[8%]">
        <div className="flex items-center gap-2">
            <div className="h-2 w-[42%] rounded-full" style={{ backgroundColor: line }} />
            <div className="h-px flex-1" style={{ backgroundColor: outline }} />
        </div>
        <div className="grid grid-cols-2 gap-[6%]">
            {[0, 1].map(index => (
                <div key={index} className="flex flex-col gap-2">
                    <div className="h-1.5 w-[58%] rounded-full" style={{ backgroundColor: line }} />
                    <div data-ponder-picker-field className="flex h-9 items-center gap-2 rounded-lg border px-2" style={{ borderColor: outline }}>
                        <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ backgroundColor: line }}>
                            {index === 0 ? <ListMusic className="h-3 w-3" style={{ color: accent }} /> : <Volume2 className="h-3 w-3" style={{ color: accent }} />}
                        </span>
                        <span className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: line }} />
                        <ChevronDown className="h-3 w-3 opacity-45" />
                    </div>
                </div>
            ))}
        </div>
    </div>
);

const QueueContents: React.FC<{ line: string; outline: string; accent: string }> = ({ line, outline, accent }) => (
    <div className="absolute inset-0">
        <PaletteHeader line={line} outline={outline} />
        <div className="flex h-[78%] flex-col px-[4%] py-[2%]">
            {[82, 64, 74, 56].map((width, index) => (
                <div key={width} data-ponder-queue-row className="flex min-h-0 flex-1 items-center gap-2 border-b" style={{ borderColor: outline }}>
                    <GripVertical className="h-3 w-3 opacity-30" />
                    <span className="aspect-square h-[68%] rounded-md" style={{ backgroundColor: index === 0 ? accent : line, opacity: index === 0 ? 0.35 : 1 }} />
                    <span className="flex flex-1 flex-col gap-1.5">
                        <span className="h-1.5 rounded-full" style={{ width: `${width}%`, backgroundColor: line }} />
                        <span className="h-1 rounded-full opacity-65" style={{ width: `${Math.max(34, width - 28)}%`, backgroundColor: line }} />
                    </span>
                    <span className="h-4 w-4 rounded-full border" style={{ borderColor: outline }} />
                </div>
            ))}
        </div>
    </div>
);

const VolumeContents: React.FC<{ line: string; outline: string; accent: string }> = ({ line, outline, accent }) => (
    <div className="absolute inset-0">
        <PaletteHeader line={line} outline={outline} />
        <div className="flex h-[78%] flex-col justify-center gap-[16%] px-[10%]">
            <div className="flex items-center gap-3">
                <Volume2 className="h-5 w-5" style={{ color: accent }} />
                <div className="flex flex-1 flex-col gap-1.5">
                    <div className="h-2 w-[38%] rounded-full" style={{ backgroundColor: line }} />
                    <div className="h-1.5 w-[62%] rounded-full opacity-65" style={{ backgroundColor: line }} />
                </div>
                <div className="h-3 w-[13%] rounded-full" style={{ backgroundColor: line }} />
            </div>
            <div data-ponder-volume-track className="relative h-2 rounded-full" style={{ backgroundColor: line }}>
                <div className="absolute inset-y-0 left-0 w-[68%] rounded-full" style={{ backgroundColor: accent, opacity: 0.55 }} />
                <div className="absolute left-[68%] top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ borderColor: outline, backgroundColor: accent }} />
            </div>
        </div>
    </div>
);

const PageContents: React.FC<{
    kind: 'grid-page' | 'player-page' | 'lattice-page';
    line: string;
    outline: string;
    accent: string;
}> = ({ kind, line, outline, accent }) => {
    if (kind === 'player-page') {
        return (
            <div className="absolute inset-0 flex flex-col items-center justify-between p-[5%]">
                <div className="h-[8%] w-[28%] rounded-full" style={{ backgroundColor: line }} />
                <div className="aspect-square h-[52%] rounded-[12%] border" style={{ borderColor: outline, backgroundColor: accent, opacity: 0.45 }} />
                <div className="flex h-[13%] w-full items-center gap-[4%] rounded-full border px-[5%]" style={{ borderColor: outline }}>
                    <span className="h-[28%] flex-1 rounded-full" style={{ backgroundColor: line }} />
                    <span className="aspect-square h-[58%] rounded-full" style={{ backgroundColor: line }} />
                    <span className="aspect-square h-[58%] rounded-full" style={{ backgroundColor: line }} />
                </div>
            </div>
        );
    }

    const tileCount = kind === 'lattice-page' ? 12 : 8;
    return (
        <div className="absolute inset-0 flex flex-col gap-[5%] p-[5%]">
            <div className="flex h-[9%] items-center gap-[3%]">
                <Search className="h-full w-auto opacity-45" />
                <span className="h-[55%] w-[38%] rounded-full" style={{ backgroundColor: line }} />
            </div>
            <div className={`grid min-h-0 flex-1 gap-[3%] ${kind === 'lattice-page' ? 'grid-cols-4 grid-rows-3' : 'grid-cols-4 grid-rows-2'}`}>
                {Array.from({ length: tileCount }, (_, index) => (
                    <span
                        key={index}
                        className="rounded-[10%] border"
                        style={{ borderColor: outline, backgroundColor: index === 1 ? accent : line, opacity: index === 1 ? 0.5 : 0.8 }}
                    />
                ))}
            </div>
        </div>
    );
};

const PonderSurfaceContents: React.FC<PonderSurfaceContentsProps> = ({ kind, accent, line, outline }) => {
    const resolvedKind = kind ?? 'palette';
    const contents = resolvedKind === 'grid-page' || resolvedKind === 'player-page' || resolvedKind === 'lattice-page'
        ? <PageContents kind={resolvedKind} line={line} outline={outline} accent={accent} />
        : resolvedKind === 'picker'
        ? <PickerContents line={line} outline={outline} accent={accent} />
        : resolvedKind === 'queue'
            ? <QueueContents line={line} outline={outline} accent={accent} />
            : resolvedKind === 'volume'
                ? <VolumeContents line={line} outline={outline} accent={accent} />
                : <PaletteContents line={line} outline={outline} />;

    return (
        <div className="absolute inset-0" data-ponder-surface-kind={resolvedKind}>
            {contents}
        </div>
    );
};

export default PonderSurfaceContents;
