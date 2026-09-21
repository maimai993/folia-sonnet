import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/gridPage.target.ts

export default {
    id: 'grid-page',
    titleKey: 'ponder.targets.gridPage',
    hoverSelector: null,
    relatedTargetIds: [],
    scenes: [
        {
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
        },
        {
            id: 'grid-page-navigation',
            titleKey: 'ponder.scenes.gridPageNavigation',
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
                { kind: 'cursor', id: 'moveAcrossGrid', from: { anchor: 'page', x: 0.25, y: 0.45 }, to: { anchor: 'page', x: 0.72, y: 0.58 }, durationMs: 1100, keyframe: true },
                { kind: 'caption', id: 'navigation', at: 'bottom', textKey: 'ponder.captions.pages.gridNavigation', pointTo: { anchor: 'page', x: 0.72, y: 0.58 }, durationMs: 4200, withPrevious: true },
                { kind: 'pause', id: 'readNavigation' },
                { kind: 'keypress', id: 'search', keys: ['A…'], at: 'bottom', durationMs: 1200, keyframe: true },
                { kind: 'caption', id: 'searchHint', at: 'bottom', textKey: 'ponder.captions.pages.gridSearch', pointTo: { anchor: 'page', x: 0.5, y: 0.08 }, durationMs: 3600, withPrevious: true },
                { kind: 'pause', id: 'readSearch' },
            ],
        },
    ],
} satisfies PonderTargetDefinition;
