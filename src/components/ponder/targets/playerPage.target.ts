import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/playerPage.target.ts

export default {
    id: 'player-page',
    titleKey: 'ponder.targets.playerPage',
    hoverSelector: null,
    relatedTargetIds: ['player-bar', 'panel-slide'],
    scenes: [{
        id: 'player-page-overview',
        titleKey: 'ponder.scenes.playerPageOverview',
        anchors: {
            page: {
                kind: 'synthetic',
                rect: { left: 0.5, top: 0.13, width: 0.5, height: 0.58, anchorX: 'center' },
                role: 'surface',
                surfaceKind: 'player-page',
                labelKey: 'ponder.anchors.pages.player',
            },
        },
        steps: [
            { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.7], durationMs: 520 },
            { kind: 'caption', id: 'overview', at: 'bottom', textKey: 'ponder.captions.pages.player', pointTo: { anchor: 'page', y: 1 }, durationMs: 4200, withPrevious: true },
            { kind: 'pause', id: 'readOverview' },
        ],
    }],
} satisfies PonderTargetDefinition;
