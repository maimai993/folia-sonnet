import { Command, FileText, Monitor, Sparkles } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_0',
    features: [
        { id: 'temperaVisualExpansion', icon: Sparkles, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'commandPaletteWorkflows', icon: Command, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'awlrcLyrics', icon: FileText, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'desktopWindowTools', icon: Monitor, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
    ],
};
