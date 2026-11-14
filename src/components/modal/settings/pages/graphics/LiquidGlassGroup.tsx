import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useGlassSurfaceSettingsStore } from '../../../../../stores/useGlassSurfaceSettingsStore';
import {
    LIQUID_GLASS_BLOCKED_BY_GPU_PREFERENCE,
    LIQUID_GLASS_DISTORTION_SUPPORTED,
    LIQUID_GLASS_PARAM_BOUNDS,
    LIQUID_GLASS_PRESETS,
    type LiquidGlassPresetId,
} from '../../../../../shinoinject/liquidglass';
import { Group, Reveal, Row, Slider, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../../kit';
import { GlassPresetGrid } from '../pictures';

// src/components/modal/settings/pages/graphics/LiquidGlassGroup.tsx
// The 液态玻璃 group of the 性能与动效 page: the master switch, the presets, the four numeric
// parameters and the two effect switches (light, jelly). Values, defaults and storage live in
// src/shinoinject/liquidglass.ts and stores/useGlassSurfaceSettingsStore.ts; this file only draws them.

/** 扭曲与饱和度只在画得了位移图的渲染器上可调（Chromium 内核；Safari 与 iOS 上的浏览器除外）。 */
const DISTORTION = LIQUID_GLASS_DISTORTION_SUPPORTED;

/** 渲染显卡选了「省电」GPU 时流体玻璃整体停用（见 liquidglass.ts），整组只读并说明原因。 */
const GPU_BLOCKED = LIQUID_GLASS_BLOCKED_BY_GPU_PREFERENCE;

/** 预设名走 i18n。 */
const PRESET_LABEL_KEY: Record<LiquidGlassPresetId, string> = {
    frosted: 'options.liquidGlassPresetFrosted',
    clear: 'options.liquidGlassPresetClear',
    hazy: 'options.liquidGlassPresetHazy',
    eco: 'options.liquidGlassPresetEco',
};

export const LIQUID_GLASS: SettingsGroupDef = { id: 'liquidGlass', titleKey: 'options.liquidGlassSection' };

/** The group's rows: the page lists these for the settings search, and draws them below. */
export const LIQUID_GLASS_OPTIONS: SettingsOptionDef[] = [
    option(LIQUID_GLASS, 'liquidGlassEnabled', 'options.glassSurface', { noteKey: 'options.glassSurfaceDesc' }),
    option(LIQUID_GLASS, 'liquidGlassPreset', 'options.liquidGlassPreset', { noteKey: 'options.liquidGlassPresetDesc' }),
    // 强度、弯曲距离与饱和度这三行的控件在画不了位移图的平台上不存在（DISTORTION 为假），搜索也据此不列出它们。
    option(LIQUID_GLASS, 'liquidGlassStrength', 'options.liquidGlassStrength', { noteKey: 'options.liquidGlassStrengthDesc', available: () => DISTORTION }),
    option(LIQUID_GLASS, 'liquidGlassBend', 'options.liquidGlassBend', { noteKey: 'options.liquidGlassBendDesc', available: () => DISTORTION }),
    option(LIQUID_GLASS, 'liquidGlassBlur', 'options.liquidGlassBlur', { noteKey: 'options.liquidGlassBlurDesc' }),
    option(LIQUID_GLASS, 'liquidGlassSat', 'options.liquidGlassSat', { noteKey: 'options.liquidGlassSatDesc', available: () => DISTORTION }),
    option(LIQUID_GLASS, 'liquidGlassLight', 'options.liquidGlassLight', { noteKey: 'options.liquidGlassLightDesc' }),
    option(LIQUID_GLASS, 'liquidGlassJelly', 'options.liquidGlassJelly', { noteKey: 'options.liquidGlassJellyDesc' }),
];

/** Row by id, so the JSX below names the same objects the search lists and cannot drift with the order. */
const row = (id: string): SettingsOptionDef => {
    const found = LIQUID_GLASS_OPTIONS.find(candidate => candidate.id === id);
    if (!found) throw new Error(`liquid glass row ${id} is not declared`);
    return found;
};

const ROW = {
    enabled: row('liquidGlassEnabled'),
    preset: row('liquidGlassPreset'),
    strength: row('liquidGlassStrength'),
    bend: row('liquidGlassBend'),
    blur: row('liquidGlassBlur'),
    sat: row('liquidGlassSat'),
    light: row('liquidGlassLight'),
    jelly: row('liquidGlassJelly'),
};

export const LiquidGlassGroup: React.FC = () => {
    const { t } = useTranslation();
    const glass = useGlassSurfaceSettingsStore(useShallow(state => ({
        enabled: state.liquidGlassEnabled,
        setEnabled: state.setLiquidGlassEnabled,
        strength: state.strength,
        blur: state.blur,
        sat: state.sat,
        bend: state.bend,
        light: state.light,
        jelly: state.jelly,
        setStrength: state.handleSetLiquidGlassStrength,
        setBlur: state.handleSetLiquidGlassBlur,
        setSat: state.handleSetLiquidGlassSat,
        setBend: state.handleSetLiquidGlassBend,
        setParams: state.handleSetLiquidGlassParams,
        setLight: state.handleSetLiquidGlassLight,
        setJelly: state.handleSetLiquidGlassJelly,
    })));

    // 预设：画不了位移图的平台不列出通透/朦胧流体；按当前值高亮（那边强度与弯曲距离被钉死，只按模糊匹配）。
    // 声明成 string：没有匹配项时用空串表示「没有预设被选中」，而 Segmented 的 value 与 options 用同一类型。
    const presets = LIQUID_GLASS_PRESETS.filter(preset => !preset.needsDistortion || DISTORTION);
    const activePreset: string = presets.find(preset => (
        DISTORTION
            ? glass.strength === preset.strength && glass.blur === preset.blur && glass.bend === preset.bend
            : glass.blur === preset.blur
    ))?.id ?? '';
    const applyPreset = (id: string) => {
        const preset = LIQUID_GLASS_PRESETS.find(candidate => candidate.id === id);
        if (preset) glass.setParams({ strength: preset.strength, blur: preset.blur, bend: preset.bend });
    };

    const off = GPU_BLOCKED || !glass.enabled;

    return (
        <Group def={LIQUID_GLASS} foot={t('options.liquidGlassSectionDesc')}>
            {GPU_BLOCKED && <Row sub notice={t('options.liquidGlassGpuBlockedNotice')} />}
            <Row option={ROW.enabled} disabled={GPU_BLOCKED}>
                <Toggle checked={glass.enabled} onChange={glass.setEnabled} />
            </Row>
            {/* 下面每一项都只在总开关打开时有意义，所以收在 Reveal 里；关着时整组不占地方。 */}
            <Reveal when={!off}>
                {/* 预设用上游原版的 2×2 预览图网格（GlassPresetGrid），不是分段按钮：
                    四个预设的差别主要在图上看，光靠名字分不出通透流体和朦胧流体。 */}
                <Row option={ROW.preset} disabled={off} below={(
                    <GlassPresetGrid
                        value={activePreset}
                        label={t('options.liquidGlassPreset')}
                        options={presets.map(preset => ({ value: preset.id as string, label: t(PRESET_LABEL_KEY[preset.id]) }))}
                        onChange={applyPreset}
                    />
                )} />
                {DISTORTION && (
                    <Row option={ROW.strength} disabled={off}>
                        <Slider
                            value={glass.strength}
                            min={LIQUID_GLASS_PARAM_BOUNDS.strength.min}
                            max={LIQUID_GLASS_PARAM_BOUNDS.strength.max}
                            step={0.25}
                            onChange={glass.setStrength}
                            format={value => value.toFixed(2)}
                        />
                    </Row>
                )}
                {DISTORTION && (
                    <Row option={ROW.bend} disabled={off}>
                        <Slider
                            value={glass.bend}
                            min={LIQUID_GLASS_PARAM_BOUNDS.bend.min}
                            max={LIQUID_GLASS_PARAM_BOUNDS.bend.max}
                            step={2}
                            onChange={glass.setBend}
                            format={value => `${Math.round(value)}px`}
                        />
                    </Row>
                )}
                <Row option={ROW.blur} disabled={off}>
                    <Slider
                        value={glass.blur}
                        min={LIQUID_GLASS_PARAM_BOUNDS.blur.min}
                        max={LIQUID_GLASS_PARAM_BOUNDS.blur.max}
                        step={0.5}
                        onChange={glass.setBlur}
                        format={value => value.toFixed(1)}
                    />
                </Row>
                {DISTORTION && (
                    <Row option={ROW.sat} disabled={off}>
                        <Slider
                            value={glass.sat}
                            min={LIQUID_GLASS_PARAM_BOUNDS.sat.min}
                            max={LIQUID_GLASS_PARAM_BOUNDS.sat.max}
                            step={5}
                            onChange={glass.setSat}
                            format={value => `${Math.round(value)}%`}
                        />
                    </Row>
                )}
                <Row option={ROW.light} disabled={off}>
                    <Toggle checked={glass.light} onChange={glass.setLight} />
                </Row>
                <Row option={ROW.jelly} disabled={off}>
                    <Toggle checked={glass.jelly} onChange={glass.setJelly} />
                </Row>
            </Reveal>
        </Group>
    );
};

export default LiquidGlassGroup;
