import type { PonderTargetDefinition, PonderSurfaceKind } from '../../../types/ponder';

// src/components/ponder/targets/helpPage.target.ts

const surface = (labelKey: string, surfaceKind: PonderSurfaceKind) => ({
    page: {
        kind: 'synthetic' as const,
        rect: { left: 0.5, top: 0.15, width: 0.56, height: 0.5, anchorX: 'center' as const },
        role: 'surface' as const,
        surfaceKind,
        labelKey,
    },
});

export default {
    id: 'help-page',
    titleKey: 'ponder.targets.helpPage',
    hoverSelector: null,
    relatedTargetIds: [],
    scenes: [
        {
            id: 'help-page-overview',
            titleKey: 'ponder.scenes.helpPageOverview',
            anchors: surface('ponder.anchors.pages.help', 'help-page'),
            steps: [
                { kind: 'highlight', id: 'showHelp', anchor: 'page', intensity: [0, 0.7], durationMs: 520 },
                { kind: 'caption', id: 'overview', at: 'bottom', textKey: 'ponder.captions.pages.help', pointTo: { anchor: 'page', y: 1 }, durationMs: 4300, withPrevious: true },
                { kind: 'pause', id: 'readOverview' },
            ],
        },
        {
            id: 'help-page-command-palette',
            titleKey: 'ponder.scenes.helpPageCommands',
            anchors: surface('ponder.anchors.pages.commandPalette', 'palette'),
            steps: [
                { kind: 'keypress', id: 'openPalette', keys: ['S'], at: 'bottom', durationMs: 1200, keyframe: true },
                { kind: 'highlight', id: 'showPalette', anchor: 'page', intensity: [0, 0.75], durationMs: 520 },
                { kind: 'caption', id: 'commands', at: 'bottom', textKey: 'ponder.captions.pages.helpCommands', pointTo: { anchor: 'page', y: 1 }, durationMs: 4300, withPrevious: true },
                { kind: 'pause', id: 'readCommands' },
            ],
        },
        {
            id: 'help-page-operating-model',
            titleKey: 'ponder.scenes.helpPageOperatingModel',
            anchors: surface('ponder.anchors.pages.player', 'player-page'),
            steps: [
                { kind: 'highlight', id: 'showPlayer', anchor: 'page', intensity: [0, 0.65], durationMs: 520 },
                { kind: 'caption', id: 'operatingModel', at: 'bottom', textKey: 'ponder.captions.pages.helpOperatingModel', pointTo: { anchor: 'page', y: 1 }, durationMs: 4800, withPrevious: true },
                { kind: 'pause', id: 'readOperatingModel' },
            ],
        },
    ],
} satisfies PonderTargetDefinition;
