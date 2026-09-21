import { THEME_SETTINGS_GEOMETRY as G } from '../surfaces/ponderSurfaceGeometry';
import type { PonderAnchorSource, PonderRelativeRect, PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/themeSettings.target.ts
// 设置 · 外观里的「配色主题预设」那一组。
//
// 这一组容易被当成「只有两个预设可选」就翻过去了，其实它有三层：预设、自定义、
// 以及决定自定义配色从哪来的生成来源。Theme Park 又是另一个整屏的库。

const panel = {
    kind: 'synthetic',
    rect: { left: 0.5, top: 0.13, width: 0.48, height: 0.48, anchorX: 'center' },
    role: 'surface',
    surfaceKind: 'theme-settings',
    labelKey: 'ponder.anchors.themeSettings.panel',
} satisfies PonderAnchorSource;

const region = (rect: PonderRelativeRect, labelKey: string): PonderAnchorSource => (
    { kind: 'relative', from: 'panel', rect, role: 'region', labelKey }
);

const anchors = {
    panel,
    themePark: region(G.themePark, 'ponder.anchors.themeSettings.themePark'),
    presetDefault: region(G.presetDefault, 'ponder.anchors.themeSettings.presetDefault'),
    presetCustom: region(G.presetCustom, 'ponder.anchors.themeSettings.presetCustom'),
    source: region(G.source, 'ponder.anchors.themeSettings.source'),
} satisfies Record<string, PonderAnchorSource>;

/** 第一章：两张预设卡分别是什么。 */
const presets: PonderSceneScript = {
    id: 'theme-settings-presets',
    titleKey: 'ponder.scenes.themeSettingsPresets',
    action: {
        kind: 'openSettings',
        anchorId: 'themePresets',
        labelKey: 'ponder.actions.openThemePresets',
    },
    anchors,
    steps: [
        { kind: 'highlight', id: 'markDefault', anchor: 'presetDefault', intensity: [0, 0.8], durationMs: 440, keyframe: true },
        {
            kind: 'caption', id: 'default', at: 'bottom',
            textKey: 'ponder.captions.themeSettings.presetDefault',
            pointTo: { anchor: 'presetDefault' }, durationMs: 5000, withPrevious: true,
        },
        { kind: 'pause', id: 'readDefault' },

        { kind: 'highlight', id: 'markCustom', anchor: 'presetCustom', intensity: [0, 0.8], durationMs: 440, keyframe: true },
        {
            kind: 'caption', id: 'custom', at: 'bottom',
            textKey: 'ponder.captions.themeSettings.presetCustom',
            pointTo: { anchor: 'presetCustom' }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readCustom' },
    ],
};

/** 第二章：自定义配色从哪来，以及整屏的 Theme Park。 */
const sourceAndPark: PonderSceneScript = {
    id: 'theme-settings-source',
    titleKey: 'ponder.scenes.themeSettingsSource',
    anchors,
    steps: [
        { kind: 'highlight', id: 'markSource', anchor: 'source', intensity: [0, 0.8], durationMs: 440, keyframe: true },
        {
            kind: 'caption', id: 'source', at: 'bottom',
            textKey: 'ponder.captions.themeSettings.source',
            pointTo: { anchor: 'source' }, durationMs: 5800, withPrevious: true,
        },
        { kind: 'pause', id: 'readSource' },

        { kind: 'cursor', id: 'openPark', to: { anchor: 'themePark' }, press: 'tap', durationMs: 660, keyframe: true },
        // 同上：Theme Park 铺上来之后，留在底下的高亮要熄掉。
        { kind: 'highlight', id: 'dimSource', anchor: 'source', intensity: [0.8, 0], durationMs: 420, withPrevious: true },
        { kind: 'surfaceState', id: 'parkOpens', anchor: 'panel', state: 'theme-park-open', transition: 'zoom', durationMs: 560 },
        {
            kind: 'caption', id: 'park', at: 'bottom',
            textKey: 'ponder.captions.themeSettings.themePark',
            pointTo: { anchor: 'panel', y: 0.5 }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readPark' },
    ],
};

export default {
    id: 'theme-settings',
    titleKey: 'ponder.targets.themeSettings',
    hoverSelector: '[data-settings-anchor="themePresets"]',
    relatedTargetIds: ['settings-page', 'lyrics-animation-settings'],
    scenes: [presets, sourceAndPark],
} satisfies PonderTargetDefinition;
