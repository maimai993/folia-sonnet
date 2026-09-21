import React from 'react';
import '../../src/i18n/config';
import PonderHost from '../../src/components/ponder/PonderHost';
import { usePonderStore } from '../../src/stores/usePonderStore';
import type { Theme } from '../../src/types';
import type { PonderTargetId } from '../../src/types/ponder';
import type { ProbeDefinition } from './definition';

// dev/probes/ponderPageSurfaces.probe.tsx

const PROBE_THEME = { accentColor: '#f43f5e' } as Theme;

const ENTRIES: Array<{ id: string; target: PonderTargetId; scene: number }> = [
    { id: 'grid-card-result', target: 'grid-page', scene: 2 },
    { id: 'grid-map-result', target: 'grid-page', scene: 3 },
    { id: 'grid-view-info', target: 'grid-view-page', scene: 2 },
    { id: 'lattice-poster', target: 'lattice-page', scene: 2 },
    { id: 'lattice-tools', target: 'lattice-page', scene: 3 },
    { id: 'player-page-layout', target: 'player-page', scene: 0 },
    { id: 'player-page-palette', target: 'player-page', scene: 1 },
    { id: 'player-page-commands', target: 'player-page', scene: 2 },
    { id: 'player-page-shuffle', target: 'player-page', scene: 3 },
    { id: 'command-palette-execute', target: 'command-palette', scene: 2 },
    { id: 'side-panel-tabs', target: 'side-panel', scene: 1 },
    { id: 'side-panel-queue', target: 'side-panel', scene: 4 },
    { id: 'lattice-chrome-slots', target: 'lattice-chrome', scene: 1 },
    { id: 'lattice-chrome-bar', target: 'lattice-chrome', scene: 2 },
    { id: 'lyrics-animation', target: 'lyrics-animation-settings', scene: 0 },
    { id: 'theme-settings', target: 'theme-settings', scene: 0 },
    { id: 'player-bar-basics', target: 'player-bar', scene: 0 },
    { id: 'player-bar-height', target: 'player-bar', scene: 1 },
    { id: 'player-bar-shuffle', target: 'player-bar', scene: 3 },
    { id: 'player-bar-volume', target: 'player-bar', scene: 4 },
];

const ProbeBody: React.FC = () => (
    <div className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
        <div className="flex flex-wrap gap-2">
            {ENTRIES.map(entry => (
                <button
                    key={entry.id}
                    type="button"
                    data-probe-open={entry.id}
                    onClick={() => usePonderStore.getState().openPonder(entry.target, entry.scene)}
                    className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs"
                >
                    {entry.id}
                </button>
            ))}
        </div>
        <PonderHost theme={PROBE_THEME} isDaylight={false} />
    </div>
);

const probe: ProbeDefinition = {
    id: 'ponderPageSurfaces',
    title: 'Ponder page surfaces and operation results',
    description: 'Real page silhouettes plus animated Grid3D, GridView, and Lattice outcomes',
    Component: ProbeBody,
};

export default probe;
