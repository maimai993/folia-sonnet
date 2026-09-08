import { AlertCircle, Command, FolderOpen, MonitorPlay, Radio, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// src/components/modal/newFeaturesRelease.ts

type NewFeatureCard = {
    id: string;
    icon: LucideIcon;
    daylightIconClassName: string;
    darkIconClassName: string;
};

type NewFeaturesRelease = {
    i18nKey: string;
    features: NewFeatureCard[];
};

// Defines the current release's cards; their localized text lives under i18nKey in every locale.
export const NEW_FEATURES_RELEASE: NewFeaturesRelease = {
    i18nKey: 'releaseNotes.v0_7_5',
    features: [
        { id: 'playbackEntryChoice', icon: MonitorPlay, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'commandPaletteGridActions', icon: Command, daylightIconClassName: 'text-blue-600', darkIconClassName: 'text-blue-400' },
        { id: 'localFolderRecovery', icon: FolderOpen, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'neteaseScrobble', icon: Radio, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'desktopReliability', icon: AlertCircle, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'visualizerRefinements', icon: Sparkles, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
    ],
};
