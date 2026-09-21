import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/gridPage.target.ts

export default {
    id: 'grid-page',
    titleKey: 'ponder.targets.gridPage',
    hoverSelector: null,
    relatedTargetIds: [],
    scenes: [{
        id: 'grid-page-overview',
        titleKey: 'ponder.scenes.gridPageOverview',
        anchors: {
            page: {
                kind: 'synthetic',
                rect: { left: 0.5, top: 0.16, width: 0.58, height: 0.52, anchorX: 'center' },
                role: 'surface',
                surfaceKind: 'grid-page',
                labelKey: 'ponder.anchors.pages.grid',
            },
        },
        steps: [
            { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.7], durationMs: 520 },
            { kind: 'caption', id: 'overview', at: 'bottom', textKey: 'ponder.captions.pages.grid', pointTo: { anchor: 'page', y: 1 }, durationMs: 4200, withPrevious: true },
            { kind: 'pause', id: 'readOverview' },
        ],
    }],
} satisfies PonderTargetDefinition;
