import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { type Theme, type SubtitleContentMode, type SubtitleOverlayLayout, type VisualizerBackgroundMode, type VisualizerMode } from '../../../types';
import { Button, Group, PictureGrid, Reveal, Row, Segmented, Select, Tabs, Value, type PictureState } from '../../modal/settings/kit';
import type { SettingsGroupDef } from '../../modal/settings/kit';
import { StudioColumnBody } from '../../shared/StudioWindow';
import { percent, SliderRow, ToggleRow } from '../panelRows';
import { type VisualizerRegistryEntry } from '../registry';
import { type VisPlaygroundEditSection } from './VisPlaygroundPreviewHotspots';
import { FontTiles, type FontChoice } from './FontTiles';
import SubtitleOverlayRowsSetting from './SubtitleOverlayRowsSetting';
import type { StyleDraft } from './useTuningDrafts';
import type { VisualizerTuningSettings } from '../tuningDefinition';
import { FoliumTuningCards, tuningsRegistry } from '@/mods/folium/registries/tunings';
import { backgroundsRegistry } from '@/mods/folium/registries/backgrounds';
import { useFoliumRegistryEntries } from '@/mods/runtime/registry';
import { useMissingFoliumSelections } from '@/mods/runtime/missingEntries';
import { type PreviewPlaceholderId } from '../PreviewPlaceholder';
import type { VisualizerBackgroundActions, VisualizerBackgroundConfig } from '../backgrounds/definition';
import {
    DEFAULT_VISUALIZER_BACKGROUND_MODE,
    getVisualizerBackgroundModeLabel,
    getVisualizerBackgroundRegistryEntry,
    VISUALIZER_BACKGROUND_REGISTRY,
} from '../backgrounds/registry';
import BackgroundPicture from '../preview/BackgroundPicture';
import { usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import {
    getDirectorStateVersion,
    readDirectorSettings,
    subscribeDirectorState,
    updateDirectorSettings,
} from '../../../services/lyricDirector/state';
// 上游 v0.7.22 的随机池（参与随机的样式）。fork 这边只留池子本身，智能动感模式那两张卡片已随功能砍掉。
import RandomPoolGroup from '../random/RandomPoolGroup';
import { useRandomPool } from '../random/useRandomPool';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import SmartBeatSettingsCard from '../SmartBeatSettingsCard';
import BeatEffectsGroup from '../BeatEffectsGroup';

// src/components/visualizer/window/VisPlaygroundSettingsPanel.tsx
// The right column of the lyric style window: five tabs with one "default" action for the open
// tab, and the open tab's options as settings-kit groups. The chosen style's and the chosen
// background's own options come from their registry entries and are stacked as they come. With 随机
// chosen on the shelf, the style tab is the random pool alone (RandomPoolGroup), no style's own
// options; 智能动感模式 is a switch of the whole picture and has the 全局 tab to itself.
interface PresetOption<T> {
    label: string;
    value: T;
}

interface VisPlaygroundSettingsPanelProps {
    activeSection: VisPlaygroundEditSection;
    onSectionChange: (section: VisPlaygroundEditSection) => void;
    t: (key: string) => string;
    isDaylight: boolean;
    theme: Theme;
    visualizerMode: VisualizerMode;
    visualizerEntry: VisualizerRegistryEntry;
    /** The chosen style's tuning as the window shows it, with its change and its reset. */
    styleDraft: StyleDraft;
    /** The settings store's fields of the styles and the backgrounds, handed on to the style's own panel. */
    settings: VisualizerTuningSettings;
    controlCardBg: string;
    rangeInputClass: string;
    visualizerOpacity: number;
    onVisualizerOpacityChange?: (opacity: number) => void;
    backgroundConfig?: VisualizerBackgroundConfig;
    backgroundActions?: VisualizerBackgroundActions;
    previewPlaceholderId: PreviewPlaceholderId;
    previewPlaceholderOptions: PresetOption<PreviewPlaceholderId>[];
    onPreviewPlaceholderChange: (id: PreviewPlaceholderId) => void;
    fontStyleValue: FontChoice;
    fontStyleOptions: PresetOption<FontChoice>[];
    subtitleFontStyleOptions: PresetOption<FontChoice>[];
    onFontStyleChange: (fontStyle: FontChoice) => void;
    /** The custom lyric font, when one is chosen: its picture is drawn in it. */
    customFontFamily: string | null;
    /** The custom font's name as the user sees it. */
    currentFontLabel: string;
    fontScale: number;
    /** The sizes people come back to: marks on the size slider. */
    fontScaleOptions: PresetOption<number>[];
    onFontScaleChange: (fontScale: number) => void;
    subtitleFontScale: number;
    onSubtitleFontScaleChange: (fontScale: number) => void;
    fontWeight: number | null;
    /** The weights people come back to: marks on the weight sliders. */
    fontWeightOptions: PresetOption<number>[];
    onFontWeightChange: (fontWeight: number | null) => void;
    onFontWeightFollowChange: (follow: boolean) => void;
    onResetCommonSettings?: () => void;
    hideTranslationSubtitle: boolean;
    onToggleHideTranslationSubtitle?: (hidden: boolean) => void;
    onToggleShowSubtitleTranslation?: (shown: boolean) => void;
    subtitleContentMode: SubtitleContentMode;
    onSubtitleContentModeChange?: (mode: SubtitleContentMode) => void;
    subtitleOverlayLayout: SubtitleOverlayLayout;
    onSubtitleOverlayLayoutChange?: (layout: SubtitleOverlayLayout) => void;
    subtitleOverlayOpacity: number;
    onSubtitleOverlayOpacityChange?: (opacity: number) => void;
    subtitleOverlayBackground: boolean;
    onToggleSubtitleOverlayBackground?: (enabled: boolean) => void;
    subtitleUpcomingLyricsBlur: boolean;
    onToggleSubtitleUpcomingLyricsBlur?: (enabled: boolean) => void;
    showHarmonySubtitle: boolean;
    onToggleShowHarmonySubtitle?: (enabled: boolean) => void;
    harmonySubtitleBackground: boolean;
    onToggleHarmonySubtitleBackground?: (enabled: boolean) => void;
    subtitleFontInheritsLyrics: boolean;
    onSubtitleFontInheritsLyricsChange?: (inheritsLyrics: boolean) => void;
    subtitleFontStyle: Theme['fontStyle'];
    subtitleFontWeight: number | null;
    onSubtitleFontStyleChange?: (fontStyle: Theme['fontStyle']) => void;
    onSubtitleFontWeightChange?: (fontWeight: number | null) => void;
    onSubtitleFontWeightFollowChange?: (follow: boolean) => void;
    subtitleFontFamily?: string | null;
    onSubtitleFontFamilyChange?: (fontFamily: string | null) => void;
    onOpenSubtitleFontPicker?: () => void;
    onResetSubtitleSettings?: () => void;
    onSliderPointerDown?: () => void;
    onSliderCommit?: () => void;
}

const SECTION_OPTIONS: VisPlaygroundEditSection[] = ['visualizer', 'background', 'common', 'subtitle', 'global'];

const SECTION_LABEL_KEYS: Record<VisPlaygroundEditSection, string> = {
    visualizer: 'options.previewVisualizerSettings',
    background: 'options.previewBackgroundSettings',
    common: 'options.previewCommonSettings',
    subtitle: 'options.previewSubtitleSettings',
    global: 'options.previewGlobalSettings',
};

// The window's own groups. A group without a heading still needs a name for assistive tech.
const STYLE_NOTICE_GROUP: SettingsGroupDef = { id: 'vis-style-notice', titleKey: 'options.previewVisualizerGroup' };
const BACKGROUND_NOTICE_GROUP: SettingsGroupDef = { id: 'vis-background-notice', titleKey: 'options.previewBackgroundGroup' };
/** 无标题组（bare）：随机动画是这一栏的第一行，上面不再挂一个「歌词动画」的标题。 */
const RANDOM_ANIMATION_GROUP: SettingsGroupDef = { id: 'vis-random-animation', titleKey: 'options.previewVisualizerGroup' };
const BACKGROUND_KIND_GROUP: SettingsGroupDef = { id: 'vis-background-kind', titleKey: 'options.visualizerBackgroundMode' };
const COMMON_GROUP: SettingsGroupDef = { id: 'vis-common', titleKey: 'options.previewCommonSettings' };
const SUBTITLE_GROUP: SettingsGroupDef = { id: 'vis-subtitle', titleKey: 'options.previewSubtitleSettings' };
const HARMONY_GROUP: SettingsGroupDef = { id: 'vis-harmony', titleKey: 'options.harmonySubtitleSettings' };
const SUBTITLE_FONT_GROUP: SettingsGroupDef = { id: 'vis-subtitle-font', titleKey: 'options.subtitleFontFamily' };

const toMarks = (options: PresetOption<number>[]) => options.map(option => ({ value: option.value, label: option.label }));

const drawBackground = (mode: VisualizerBackgroundMode, state: PictureState) => <BackgroundPicture mode={mode} {...state} />;

const VisPlaygroundSettingsPanel: React.FC<VisPlaygroundSettingsPanelProps> = (props) => {
    const {
        activeSection,
        onSectionChange,
        t,
        isDaylight,
        theme,
        visualizerMode,
        visualizerEntry,
        styleDraft,
        settings,
        controlCardBg,
        rangeInputClass,
        visualizerOpacity,
        onVisualizerOpacityChange,
        backgroundConfig,
        backgroundActions,
        previewPlaceholderId,
        previewPlaceholderOptions,
        onPreviewPlaceholderChange,
        fontStyleValue,
        fontStyleOptions,
        subtitleFontStyleOptions,
        onFontStyleChange,
        customFontFamily,
        currentFontLabel,
        fontScale,
        fontScaleOptions,
        onFontScaleChange,
        subtitleFontScale,
        onSubtitleFontScaleChange,
        fontWeight,
        fontWeightOptions,
        onFontWeightChange,
        onFontWeightFollowChange,
        onResetCommonSettings,
        hideTranslationSubtitle,
        onToggleHideTranslationSubtitle,
        onToggleShowSubtitleTranslation,
        subtitleContentMode,
        onSubtitleContentModeChange,
        subtitleOverlayLayout,
        onSubtitleOverlayLayoutChange,
        subtitleOverlayOpacity,
        onSubtitleOverlayOpacityChange,
        subtitleOverlayBackground,
        onToggleSubtitleOverlayBackground,
        subtitleUpcomingLyricsBlur,
        onToggleSubtitleUpcomingLyricsBlur,
        showHarmonySubtitle,
        onToggleShowHarmonySubtitle,
        harmonySubtitleBackground,
        onToggleHarmonySubtitleBackground,
        subtitleFontInheritsLyrics,
        onSubtitleFontInheritsLyricsChange,
        subtitleFontStyle,
        subtitleFontWeight,
        onSubtitleFontWeightChange,
        onSubtitleFontWeightFollowChange,
        onSubtitleFontStyleChange,
        subtitleFontFamily,
        onSubtitleFontFamilyChange,
        onOpenSubtitleFontPicker,
        onResetSubtitleSettings,
        onSliderPointerDown,
        onSliderCommit,
    } = props;
    // A style that sizes its own lyrics: the font size row is disabled and its notice says why.
    const lyricsFontSizeAutoNoticeKey = visualizerEntry.ownFontSizeNoticeKey ?? null;
    const [fontWeightSliderValue, setFontWeightSliderValue] = useState(fontWeight ?? 400);
    const [subtitleFontWeightSliderValue, setSubtitleFontWeightSliderValue] = useState(subtitleFontWeight ?? 400);

    useEffect(() => {
        if (fontWeight !== null) setFontWeightSliderValue(fontWeight);
    }, [fontWeight]);
    useEffect(() => {
        if (subtitleFontWeight !== null) setSubtitleFontWeightSliderValue(subtitleFontWeight);
    }, [subtitleFontWeight]);

    // Mod backgrounds and tunings come and go at runtime (Folium registries), so what is listed
    // here recomputes on registry changes, not only on language changes.
    const foliumBackgroundEntries = useFoliumRegistryEntries(backgroundsRegistry);
    const hasModTunings = useFoliumRegistryEntries(tuningsRegistry).some(entry => entry.def.target === visualizerMode);
    const missingFoliumSelections = useMissingFoliumSelections();
    const randomEnabled = useVisualizerSettingsStore(state => state.randomVisualizerModePerSong);
    const randomPool = useRandomPool();

    const enablePlayerPageNativeBlur = usePlayerChromeSettingsStore(state => state.enablePlayerPageNativeBlur);
    const randomVisualizerModePerSong = useVisualizerSettingsStore(state => state.randomVisualizerModePerSong);
    const setRandomVisualizerModePerSong = useVisualizerSettingsStore(state => state.handleToggleRandomVisualizerModePerSong);
    // 「允许 AI 自动切换」与 AI 设置卡里那颗是同一份值（lyricDirector 的 autoOnSongChange）：
    // 这里只是把它也摆到动画参数这一页，两处开关谁拨都一样。
    useSyncExternalStore(subscribeDirectorState, getDirectorStateVersion);
    const directorSettings = readDirectorSettings();
    const resolvedBackgroundMode = backgroundConfig?.mode ?? DEFAULT_VISUALIZER_BACKGROUND_MODE;
    const backgroundEntry = getVisualizerBackgroundRegistryEntry(resolvedBackgroundMode);
    const backgroundModeOptions = useMemo(() => (
        VISUALIZER_BACKGROUND_REGISTRY.map(entry => ({
            value: entry.mode,
            label: getVisualizerBackgroundModeLabel(entry.mode, t),
        }))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [t, foliumBackgroundEntries]);
    const missingNotice = (kind: 'visualizer' | 'background') => {
        const missing = missingFoliumSelections.find(entry => entry.kind === kind);
        return missing ? t('options.foliumMissingSelection').replace('{{modId}}', missing.modId) : null;
    };
    const missingStyleNotice = missingNotice('visualizer');
    const missingBackgroundNotice = missingNotice('background');
    const fontScaleMarks = useMemo(() => toMarks(fontScaleOptions), [fontScaleOptions]);
    const fontWeightMarks = useMemo(() => toMarks(fontWeightOptions), [fontWeightOptions]);

    // What the one "default" action does for the open tab; nothing where the tab has nothing to reset.
    // With 随机 chosen the style tab is the pool, and its default is every built-in style.
    const resetOpenTab: (() => void) | undefined = activeSection === 'visualizer'
        ? (randomEnabled
            ? (randomPool.allOn ? undefined : randomPool.selectAll)
            : (visualizerEntry.renderSettingsPanel ? styleDraft.reset : undefined))
        : activeSection === 'background'
            ? (backgroundEntry.resetSettings ? () => backgroundEntry.resetSettings?.(backgroundActions) : undefined)
            : activeSection === 'common'
                ? () => {
                    onPreviewPlaceholderChange('default');
                    onResetCommonSettings?.();
                }
                : activeSection === 'subtitle'
                    ? onResetSubtitleSettings
                    : undefined;

    const stylePanel = visualizerEntry.renderSettingsPanel?.({
        t,
        isDaylight,
        theme,
        controlCardBg,
        rangeInputClass,
        tuning: styleDraft.tuning,
        onTuningChange: styleDraft.change,
        settings,
        onSliderPointerDown,
        onSliderCommit,
    });

    return (
        <>
            <Tabs
                tabs={SECTION_OPTIONS.map(section => ({ id: section, label: t(SECTION_LABEL_KEYS[section]) }))}
                activeId={activeSection}
                onSelect={id => onSectionChange(id as VisPlaygroundEditSection)}
                label={t('options.lyricsStyleSettings')}
                className="px-4 pt-2 sm:px-6"
                action={(
                    <span className="pr-3 sm:pr-4">
                        <Button variant="quiet" disabled={!resetOpenTab} onClick={() => resetOpenTab?.()}>{t('ui.default')}</Button>
                    </span>
                )}
            />
            <StudioColumnBody>
                {/* 这一栏比设置窗口窄，kit 那套 py-2.5 的行距在这儿挤成一团 —— 打上标记，
                    由 kit.css 把行与行的上下留白拉大一点（只管这一栏，不动设置窗口）。 */}
                <div key={activeSection} className="st-page-in" data-folia-vis-settings="true">
                    {activeSection === 'visualizer' && (
                        <>
                            {/*
                             * 随机动画：整幅画面怎么动由它定，所以放在这一栏最上面，在「智能动感模式」
                             * 与各样式自己的选项之前。
                             *
                             * 与 AI 导演那条路是同一件事的两种做法（都在切歌时替你选一个样式），所以
                             * 排除清单用导演那份（lyricDirector/state.ts 的 blockedModes），随机的那一票
                             * 又压过 AI 自动给的答案 —— 两处都写在各自的实现里，这里只是开关。
                             */}
                            <Group def={RANDOM_ANIMATION_GROUP} bare>
                                <ToggleRow
                                    label={t('options.randomVisualizerMode')}
                                    note={t('options.randomVisualizerModeDesc')}
                                    checked={randomVisualizerModePerSong}
                                    onChange={setRandomVisualizerModePerSong}
                                />
                                <ToggleRow
                                    label={t('aiDirector.allowAutoMode')}
                                    note={t('aiDirector.allowAutoModeDesc')}
                                    checked={directorSettings.autoOnSongChange}
                                    onChange={(next) => updateDirectorSettings({ autoOnSongChange: next })}
                                />
                                <Row label={t('options.directorPriority')} note={t('options.directorPriorityDesc')}>
                                    <Segmented<'ai' | 'random'>
                                        value={directorSettings.autoDecisionPriority}
                                        options={[
                                            { value: 'ai', label: t('options.directorPriorityAi') },
                                            { value: 'random', label: t('options.directorPriorityRandom') },
                                        ]}
                                        onChange={(next) => updateDirectorSettings({ autoDecisionPriority: next })}
                                    />
                                </Row>
                            </Group>
                            {/* 随机开着时，池子列在样式选项之前：它决定「每首换一种」能换成哪些。 */}
                            {randomEnabled && <RandomPoolGroup />}
                            {missingStyleNotice && (
                                <Group def={STYLE_NOTICE_GROUP} bare>
                                    <Row notice={missingStyleNotice} />
                                </Group>
                            )}
                            {/* 智能动感模式: a setting of the whole picture, above whichever style's own options. */}
                            <SmartBeatSettingsCard t={t} />
                            {/* The style's own options: kit groups, stacked as they come. */}
                            <div key={visualizerMode} className="st-page-in">
                                {/* Its 智能动感模式 effects, each named, switched and scaled on its own. */}
                                <BeatEffectsGroup
                                    t={t}
                                    effects={visualizerEntry.beatEffects}
                                    onSliderPointerDown={onSliderPointerDown}
                                    onSliderCommit={onSliderCommit}
                                />
                                {stylePanel}
                                {/* Folium tunings other mods registered for this mode (registries.tunings): cards of the mods' own make. */}
                                <div className="mt-7 space-y-4 empty:hidden">
                                    <FoliumTuningCards
                                        mode={visualizerMode}
                                        theme={theme}
                                        isDaylight={isDaylight}
                                        controlCardBg={controlCardBg}
                                        rangeInputClass={rangeInputClass}
                                        description={t('options.foliumTuningDesc')}
                                    />
                                </div>
                                {!stylePanel && !hasModTunings && (
                                    <p className="py-14 text-center text-[13px] text-[color:var(--st-t3)]">{t('options.lyricStyleNoOptions')}</p>
                                )}
                            </div>
                        </>
                    )}

                    {activeSection === 'background' && (
                        <>
                            {(enablePlayerPageNativeBlur || missingBackgroundNotice) && (
                                <Group def={BACKGROUND_NOTICE_GROUP} bare>
                                    {enablePlayerPageNativeBlur && <Row notice={t('options.nativeBlurBackgroundNotice')} />}
                                    {missingBackgroundNotice && <Row notice={missingBackgroundNotice} />}
                                </Group>
                            )}
                            <Group def={BACKGROUND_KIND_GROUP}>
                                <div className="py-3">
                                    <PictureGrid
                                        value={resolvedBackgroundMode}
                                        options={backgroundModeOptions}
                                        picture={drawBackground}
                                        columns={3}
                                        onChange={mode => backgroundActions?.onModeChange?.(mode)}
                                        label={t('options.visualizerBackgroundMode')}
                                    />
                                </div>
                            </Group>
                            {/* The chosen background's own options. */}
                            <div key={resolvedBackgroundMode} className="st-page-in mt-7">
                                {backgroundEntry.renderSettingsPanel?.({
                                    config: backgroundConfig,
                                    actions: backgroundActions,
                                    t,
                                    isDaylight,
                                    theme,
                                    controlCardBg,
                                    rangeInputClass,
                                    onSliderPointerDown,
                                    onSliderCommit,
                                })}
                            </div>
                        </>
                    )}

                    {activeSection === 'common' && (
                        <Group def={COMMON_GROUP} bare>
                            {lyricsFontSizeAutoNoticeKey !== null && <Row notice={t(lyricsFontSizeAutoNoticeKey)} />}
                            <Row label={t('options.previewText')}>
                                <Segmented value={previewPlaceholderId} options={previewPlaceholderOptions} onChange={onPreviewPlaceholderChange} />
                            </Row>
                            <Row
                                label={t('options.fontFamily')}
                                below={(
                                    <FontTiles
                                        value={fontStyleValue}
                                        options={fontStyleOptions}
                                        customFamily={customFontFamily}
                                        label={t('options.fontFamily')}
                                        onChange={onFontStyleChange}
                                    />
                                )}
                            />
                            <Reveal when={fontStyleValue === 'custom'}>
                                <Row sub label={t('options.currentFont')}>
                                    <Value tip={currentFontLabel}>{currentFontLabel}</Value>
                                    <Button onClick={() => onFontStyleChange('custom')}>{t('options.chooseSystemFont')}</Button>
                                </Row>
                            </Reveal>
                            <SliderRow
                                label={t('options.fontSize')}
                                disabled={lyricsFontSizeAutoNoticeKey !== null}
                                value={fontScale}
                                min={0.85}
                                max={1.4}
                                step={0.05}
                                marks={fontScaleMarks}
                                format={percent}
                                onChange={onFontScaleChange}
                                onDragStart={onSliderPointerDown}
                                onDragEnd={onSliderCommit}
                            />
                            <ToggleRow
                                label={t('options.fontWeightAuto')}
                                note={t('options.fontWeightAutoDesc')}
                                checked={fontWeight === null}
                                onChange={onFontWeightFollowChange}
                            />
                            <Reveal when={fontWeight !== null}>
                                <SliderRow
                                    sub
                                    label={t('options.fontWeight')}
                                    value={fontWeightSliderValue}
                                    min={100}
                                    max={900}
                                    step={10}
                                    marks={fontWeightMarks}
                                    format={String}
                                    onChange={(next) => {
                                        setFontWeightSliderValue(next);
                                        onFontWeightChange(next);
                                    }}
                                    onDragStart={onSliderPointerDown}
                                    onDragEnd={onSliderCommit}
                                />
                            </Reveal>
                            <SliderRow
                                label={t('options.visualizerOpacity')}
                                value={visualizerOpacity}
                                min={0.2}
                                max={1}
                                step={0.05}
                                format={percent}
                                onChange={next => onVisualizerOpacityChange?.(next)}
                                onDragStart={onSliderPointerDown}
                                onDragEnd={onSliderCommit}
                            />
                        </Group>
                    )}

                    {activeSection === 'subtitle' && (
                        <>
                            <Group def={SUBTITLE_GROUP} bare>
                                <ToggleRow
                                    label={t('options.hidePlayerTranslationSubtitle')}
                                    note={t('options.hidePlayerTranslationSubtitleDesc')}
                                    checked={hideTranslationSubtitle}
                                    disabled={!onToggleHideTranslationSubtitle}
                                    onChange={next => onToggleHideTranslationSubtitle?.(next)}
                                />
                                <SubtitleOverlayRowsSetting
                                    t={t}
                                    layout={subtitleOverlayLayout}
                                    onChange={onSubtitleOverlayLayoutChange}
                                />
                                <Row label={t('options.subtitleContentMode')} note={t('options.subtitleContentModeDesc')}>
                                    <Select<SubtitleContentMode>
                                        value={subtitleContentMode}
                                        options={[
                                            { label: t('options.subtitleContentTranslation'), value: 'translation' },
                                            { label: t('options.subtitleContentRomanization'), value: 'romanization' },
                                            { label: t('options.subtitleContentBoth'), value: 'both' },
                                            { label: t('options.subtitleContentNone'), value: 'none' },
                                        ]}
                                        onChange={onSubtitleContentModeChange ?? (mode => onToggleShowSubtitleTranslation?.(mode !== 'none'))}
                                    />
                                </Row>
                                <SliderRow
                                    label={t('options.subtitleOverlayOpacity')}
                                    value={subtitleOverlayOpacity}
                                    min={0.2}
                                    max={1}
                                    step={0.05}
                                    format={percent}
                                    onChange={next => onSubtitleOverlayOpacityChange?.(next)}
                                    onDragStart={onSliderPointerDown}
                                    onDragEnd={onSliderCommit}
                                />
                                <ToggleRow
                                    label={t('options.subtitleOverlayBackground')}
                                    note={t('options.subtitleOverlayBackgroundDesc')}
                                    checked={subtitleOverlayBackground}
                                    disabled={!onToggleSubtitleOverlayBackground}
                                    onChange={next => onToggleSubtitleOverlayBackground?.(next)}
                                />
                                <ToggleRow
                                    label={t('options.subtitleUpcomingLyricsBlur')}
                                    checked={subtitleUpcomingLyricsBlur}
                                    disabled={!onToggleSubtitleUpcomingLyricsBlur}
                                    onChange={next => onToggleSubtitleUpcomingLyricsBlur?.(next)}
                                />
                            </Group>

                            <Group def={HARMONY_GROUP}>
                                <ToggleRow
                                    label={t('options.showHarmonySubtitle')}
                                    note={t('options.showHarmonySubtitleDesc')}
                                    checked={showHarmonySubtitle}
                                    disabled={!onToggleShowHarmonySubtitle}
                                    onChange={next => onToggleShowHarmonySubtitle?.(next)}
                                />
                                <Reveal when={showHarmonySubtitle}>
                                    <ToggleRow
                                        sub
                                        label={t('options.harmonySubtitleBackground')}
                                        note={t('options.harmonySubtitleBackgroundDesc')}
                                        checked={harmonySubtitleBackground}
                                        disabled={!onToggleHarmonySubtitleBackground}
                                        onChange={next => onToggleHarmonySubtitleBackground?.(next)}
                                    />
                                </Reveal>
                            </Group>

                            <Group def={SUBTITLE_FONT_GROUP}>
                                <ToggleRow
                                    label={t('options.subtitleFontInheritsLyrics')}
                                    note={t('options.subtitleFontInheritsLyricsDesc')}
                                    checked={subtitleFontInheritsLyrics}
                                    disabled={!onSubtitleFontInheritsLyricsChange}
                                    onChange={next => onSubtitleFontInheritsLyricsChange?.(next)}
                                />
                                <Reveal when={!subtitleFontInheritsLyrics}>
                                    <Row
                                        sub
                                        label={t('options.subtitleFontFamily')}
                                        below={(
                                            <FontTiles
                                                value={subtitleFontFamily ? 'custom' : subtitleFontStyle}
                                                options={subtitleFontStyleOptions}
                                                customFamily={subtitleFontFamily}
                                                label={t('options.subtitleFontFamily')}
                                                onChange={(next) => {
                                                    if (next === 'custom') {
                                                        onOpenSubtitleFontPicker?.();
                                                    } else {
                                                        onSubtitleFontFamilyChange?.(null);
                                                        onSubtitleFontStyleChange?.(next);
                                                    }
                                                }}
                                            />
                                        )}
                                    />
                                    <Reveal when={Boolean(subtitleFontFamily)}>
                                        <Row sub label={t('options.currentFont')}>
                                            <Value tip={subtitleFontFamily ?? undefined}>{subtitleFontFamily}</Value>
                                            <Button onClick={() => onOpenSubtitleFontPicker?.()}>{t('options.chooseSystemFont')}</Button>
                                        </Row>
                                    </Reveal>
                                    <ToggleRow
                                        sub
                                        label={t('options.fontWeightAuto')}
                                        note={t('options.fontWeightAutoDesc')}
                                        checked={subtitleFontWeight === null}
                                        disabled={!onSubtitleFontWeightFollowChange}
                                        onChange={next => onSubtitleFontWeightFollowChange?.(next)}
                                    />
                                    <Reveal when={subtitleFontWeight !== null}>
                                        <SliderRow
                                            sub
                                            label={t('options.subtitleFontWeight')}
                                            value={subtitleFontWeightSliderValue}
                                            min={100}
                                            max={900}
                                            step={10}
                                            marks={fontWeightMarks}
                                            format={String}
                                            onChange={(next) => {
                                                setSubtitleFontWeightSliderValue(next);
                                                onSubtitleFontWeightChange?.(next);
                                            }}
                                            onDragStart={onSliderPointerDown}
                                            onDragEnd={onSliderCommit}
                                        />
                                    </Reveal>
                                </Reveal>
                                <SliderRow
                                    label={t('options.subtitleFontScale')}
                                    value={subtitleFontScale}
                                    min={0.85}
                                    max={1.4}
                                    step={0.05}
                                    format={percent}
                                    onChange={onSubtitleFontScaleChange}
                                    onDragStart={onSliderPointerDown}
                                    onDragEnd={onSliderCommit}
                                />
                            </Group>
                        </>
                    )}
                </div>
            </StudioColumnBody>
        </>
    );
};

export default VisPlaygroundSettingsPanel;
