import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/latticePage.target.ts

export default {
    id: 'lattice-page',
    titleKey: 'ponder.targets.latticePage',
    hoverSelector: null,
    relatedTargetIds: [],
    scenes: [{
        id: 'lattice-page-overview',
        titleKey: 'ponder.scenes.latticePageOverview',
        anchors: {
            page: {
                kind: 'synthetic',
                rect: { left: 0.5, top: 0.14, width: 0.62, height: 0.56, anchorX: 'center' },
                role: 'surface',
                surfaceKind: 'lattice-page',
                labelKey: 'ponder.anchors.pages.lattice',
            },
        },
        steps: [
            { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.7], durationMs: 520 },
            { kind: 'caption', id: 'overview', at: 'bottom', textKey: 'ponder.captions.pages.lattice', pointTo: { anchor: 'page', y: 1 }, durationMs: 4200, withPrevious: true },
            { kind: 'pause', id: 'readOverview' },
        ],
    }],
} satisfies PonderTargetDefinition;
