import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/gridViewPage.target.ts

const gridViewAnchor = {
    page: {
        kind: 'synthetic' as const,
        rect: { left: 0.5, top: 0.16, width: 0.62, height: 0.52, anchorX: 'center' as const },
        role: 'surface' as const,
        surfaceKind: 'grid-view-page' as const,
        labelKey: 'ponder.anchors.pages.gridView',
    },
};

export default {
    id: 'grid-view-page',
    titleKey: 'ponder.targets.gridViewPage',
    hoverSelector: null,
    relatedTargetIds: [],
    scenes: [
        {
            id: 'grid-view-page-overview',
            titleKey: 'ponder.scenes.gridViewPageOverview',
            anchors: gridViewAnchor,
            steps: [
                { kind: 'highlight', id: 'showCollection', anchor: 'page', intensity: [0, 0.7], durationMs: 520 },
                { kind: 'caption', id: 'overview', at: 'bottom', textKey: 'ponder.captions.pages.gridView', pointTo: { anchor: 'page', y: 1 }, durationMs: 4200, withPrevious: true },
                { kind: 'pause', id: 'readOverview' },
            ],
        },
        {
            id: 'grid-view-page-actions',
            titleKey: 'ponder.scenes.gridViewPageActions',
            anchors: gridViewAnchor,
            steps: [
                { kind: 'cursor', id: 'selectCard', from: { anchor: 'page', x: 0.2, y: 0.2 }, to: { anchor: 'page', x: 0.58, y: 0.55 }, press: 'tap', durationMs: 900, keyframe: true },
                { kind: 'caption', id: 'actions', at: 'bottom', textKey: 'ponder.captions.pages.gridViewActions', pointTo: { anchor: 'page', x: 0.58, y: 0.55 }, durationMs: 4200, withPrevious: true },
                { kind: 'pause', id: 'readActions' },
            ],
        },
    ],
} satisfies PonderTargetDefinition;
