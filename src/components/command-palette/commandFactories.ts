import type { HomeViewTab, ReplayGainMode, VisualizerMode } from '../../types';
import type { AppLanguagePreference } from '../../i18n/config';
import type { PanelTab } from '../UnifiedPanel';
import type { AudioEqualizerModeId } from '../../utils/audioEqualizer';
import type { CommandPaletteCommand, CommandPaletteContext, CommandPaletteGroup } from './types';

// src/components/command-palette/commandFactories.ts
// The single construction entry point for palette commands, plus the shaped factories the
// registry uses repeatedly. Everything a command does — text, gating, surface, syntax — is
// declared in one object here rather than scattered across filter functions and the shell.

export const defineCommand = (command: CommandPaletteCommand): CommandPaletteCommand => command;

// Most inline commands were "call one context toggle, report success"; this collapses them.
export const createToggleCommand = (
    id: string,
    group: CommandPaletteGroup,
    title: string,
    description: string,
    keywords: string[],
    run: (context: CommandPaletteContext) => void,
    options: Pick<CommandPaletteCommand, 'platform' | 'isAvailable' | 'icon' | 'executeShortcut'> = {},
): CommandPaletteCommand => defineCommand({
    id,
    group,
    title,
    description,
    keywords,
    ...options,
    execute: (_input, context) => {
        run(context);
        return true;
    },
});

export const createSettingsCommand = (
    id: string,
    title: string,
    description: string,
    keywords: string[],
    initialTab: 'help' | 'options',
    initialSubview: Parameters<CommandPaletteContext['settings']['openSettings']>[1] = null,
    options: Pick<CommandPaletteCommand, 'platform' | 'isAvailable' | 'executeShortcut'> = {},
): CommandPaletteCommand => ({
    id,
    group: 'settings',
    title,
    description,
    keywords,
    ...options,
    execute: (_input, context) => {
        context.settings.openSettings(initialTab, initialSubview);
        return true;
    },
});

export const createAppLanguageCommand = (
    id: string,
    preference: AppLanguagePreference,
    title: string,
    description: string,
    keywords: string[],
): CommandPaletteCommand => ({
    id,
    group: 'settings',
    title,
    description,
    keywords,
    execute: async (_input, context) => {
        await context.settings.setAppLanguagePreference(preference);
        return true;
    },
});

export const createReplayGainCommand = (
    mode: ReplayGainMode,
    title: string,
    description: string,
    keywords: string[],
): CommandPaletteCommand => ({
    id: `playback-replaygain-${mode}`,
    group: 'playback',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.playback.setReplayGainMode(mode);
        return true;
    },
});

// Applies a built-in sound preset or a saved custom slot (EQ curve plus effect chain) without opening the dialog.
export const createSoundPresetCommand = (
    presetId: AudioEqualizerModeId,
    title: string,
    description: string,
    keywords: string[],
): CommandPaletteCommand => ({
    id: `playback-sound-preset-${presetId}`,
    group: 'playback',
    title,
    description,
    keywords: [...keywords, 'sound preset', 'audio preset', '音效预设', 'yinxiaoyushe', 'yxys'],
    execute: (_input, context) => {
        context.playback.applyAudioSoundPreset(presetId);
        return true;
    },
});

export const createHomeTabCommand = (
    tab: HomeViewTab,
    title: string,
    description: string,
    keywords: string[]
): CommandPaletteCommand => ({
    id: `home-${tab}`,
    group: 'navigation',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.navigation.setHomeViewTab(tab);
        context.navigation.navigateToHome();
        return true;
    },
});

export const createPanelCommand = (
    tab: PanelTab,
    title: string,
    description: string,
    keywords: string[],
    icon?: CommandPaletteCommand['icon'],
    options: Pick<CommandPaletteCommand, 'executeShortcut'> = {},
): CommandPaletteCommand => ({
    id: `panel-${tab}`,
    group: 'panel',
    title,
    description,
    keywords,
    icon,
    ...options,
    execute: (_input, context) => {
        context.panel.setPanelTab(tab);
        context.panel.setIsPanelOpen(true);
        return true;
    },
});

export const createVisualizerCommand = (
    mode: VisualizerMode,
    title: string,
    description: string,
    keywords: string[]
): CommandPaletteCommand => ({
    id: `visualizer-${mode}`,
    group: 'visualizer',
    title,
    description,
    keywords,
    execute: (_input, context) => {
        context.visualizer.setVisualizerMode(mode);
        return true;
    },
});
