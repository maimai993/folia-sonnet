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
    { id: 'side-panel-structure', target: 'side-panel', scene: 0 },
    { id: 'side-panel-tabs', target: 'side-panel', scene: 1 },
    { id: 'panel-cover-actions', target: 'panel-cover-actions', scene: 0 },
    { id: 'panel-cover-actions-right', target: 'panel-cover-actions', scene: 1 },
    { id: 'panel-cover-tab', target: 'panel-cover-tab', scene: 0 },
    { id: 'panel-source-tab', target: 'panel-source-tab', scene: 0 },
    { id: 'panel-source-contents', target: 'panel-source-tab', scene: 1 },
    { id: 'panel-controls-tab', target: 'panel-controls-tab', scene: 0 },
    { id: 'panel-queue-tab', target: 'panel-queue-tab', scene: 0 },
    { id: 'panel-account-tab', target: 'panel-account-tab', scene: 0 },
    { id: 'lattice-chrome-slots', target: 'lattice-chrome', scene: 1 },
    { id: 'lattice-chrome-bar', target: 'lattice-chrome', scene: 2 },
    { id: 'lyrics-animation', target: 'lyrics-animation-settings', scene: 0 },
    { id: 'grid-action-slide', target: 'grid-action-button', scene: 1 },
    { id: 'grid-view-edit-cards', target: 'grid-view-edit-mode', scene: 0 },
    { id: 'local-metadata-match', target: 'local-metadata-match', scene: 0 },
    { id: 'local-folder-delete', target: 'local-folder-actions', scene: 2 },
    { id: 'local-track-sorting', target: 'local-track-sorting', scene: 0 },
    { id: 'grid3d-card-style', target: 'grid3d-card-style', scene: 0 },
    { id: 'grid-view-card-cover', target: 'grid-view-card-settings', scene: 0 },
    { id: 'grid-view-card-falloff', target: 'grid-view-card-settings', scene: 1 },
    { id: 'lattice-style-tint', target: 'lattice-style-settings', scene: 0 },
    { id: 'lattice-style-color', target: 'lattice-style-settings', scene: 1 },
    { id: 'onboarding-ponder', target: 'help-page', scene: 0 },
    { id: 'onboarding-whole-page', target: 'help-page', scene: 1 },
    { id: 'onboarding-shortcuts', target: 'help-page', scene: 3 },
    { id: 'onboarding-docs', target: 'help-page', scene: 4 },
    { id: 'theme-settings', target: 'theme-settings', scene: 0 },
    { id: 'theme-settings-park', target: 'theme-settings', scene: 1 },
    { id: 'theme-settings-auto', target: 'theme-settings', scene: 2 },
    { id: 'lyrics-animation-toggles', target: 'lyrics-animation-settings', scene: 1 },
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
