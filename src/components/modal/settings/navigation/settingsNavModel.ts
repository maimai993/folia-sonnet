import { Command, Database, FlaskConical, Keyboard, Languages, PlayCircle, Server, Sparkles, Terminal, type LucideIcon } from 'lucide-react';
// src/components/modal/settings/navigation/settingsNavModel.ts
// Single source of truth for the options-tab sections: sidebar order, grouping, titles and descriptions.

export type SettingsSectionId =
    | 'appearance'
    | 'general'
    | 'playback'
    | 'interaction'
    | 'integration'
    | 'storage'
    | 'desktop'
    | 'lab'
    | 'developer';

export interface SettingsNavItem {
    id: SettingsSectionId;
    icon: LucideIcon;
    label: string;
    description: string;
}

export interface SettingsNavGroup {
    id: string;
    label: string;
    items: SettingsNavItem[];
}

type Translate = (key: string) => string;

interface SectionSpec {
    id: SettingsSectionId;
    icon: LucideIcon;
    labelKey: string;
    descriptionKey: string;
    /** Sections that only exist on the desktop build. */
    electronOnly?: boolean;
}

interface GroupSpec {
    id: string;
    labelKey: string;
    sections: SectionSpec[];
}

/**
 * Sidebar grouping. Section order matches the flat list this replaced, so the desktop grouping is
 * purely additive and the narrow chip strip keeps its existing sequence.
 */
export const SETTINGS_NAV_GROUP_SPECS: GroupSpec[] = [
    {
        id: 'appearance',
        labelKey: 'options.settingsGroupAppearance',
        sections: [
            { id: 'appearance', icon: Sparkles, labelKey: 'options.visualSettings', descriptionKey: 'options.visualSettingsPanelDesc' },
            { id: 'general', icon: Languages, labelKey: 'options.generalSettings', descriptionKey: 'options.generalSettingsDesc' },
        ],
    },
    {
        // Named for what the group is about rather than for its first section: it now holds how the
        // listener drives the app as well as how the app plays.
        id: 'controls',
        labelKey: 'options.settingsGroupControls',
        sections: [
            { id: 'playback', icon: PlayCircle, labelKey: 'options.playbackSettings', descriptionKey: 'options.playbackSettingsPanelDesc' },
            { id: 'interaction', icon: Keyboard, labelKey: 'options.interactionSettings', descriptionKey: 'options.interactionSettingsPanelDesc' },
        ],
    },
    {
        id: 'connections',
        labelKey: 'options.settingsGroupConnections',
        sections: [
            { id: 'integration', icon: Server, labelKey: 'options.integrationSettings', descriptionKey: 'options.integrationSettingsDesc' },
            { id: 'storage', icon: Database, labelKey: 'options.storageSettings', descriptionKey: 'options.storageSettingsPanelDesc' },
        ],
    },
    {
        id: 'system',
        labelKey: 'options.settingsGroupSystem',
        sections: [
            { id: 'desktop', icon: Command, labelKey: 'options.desktopSettings', descriptionKey: 'options.desktopSettingsPanelDesc', electronOnly: true },
            { id: 'lab', icon: FlaskConical, labelKey: 'options.labSettings', descriptionKey: 'options.labSettingsDesc' },
            { id: 'developer', icon: Terminal, labelKey: 'options.developerSettings', descriptionKey: 'options.developerSettingsDesc' },
        ],
    },
];

/** Resolves the grouping into translated nav items, dropping desktop-only sections (and groups left empty) on web. */
export const buildSettingsNavGroups = (t: Translate, options: { isElectron: boolean }): SettingsNavGroup[] => (
    SETTINGS_NAV_GROUP_SPECS
        .map(group => ({
            id: group.id,
            label: t(group.labelKey),
            items: group.sections
                .filter(section => !section.electronOnly || options.isElectron)
                .map(section => ({
                    id: section.id,
                    icon: section.icon,
                    label: t(section.labelKey),
                    description: t(section.descriptionKey),
                })),
        }))
        .filter(group => group.items.length > 0)
);

export const flattenSettingsNavItems = (groups: SettingsNavGroup[]): SettingsNavItem[] => (
    groups.flatMap(group => group.items)
);

export const findSettingsNavItem = (groups: SettingsNavGroup[], id: SettingsSectionId): SettingsNavItem | undefined => (
    flattenSettingsNavItems(groups).find(item => item.id === id)
);
