import { Command, ListMusic, Pause, Sparkles } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_5',
    features: [
        { id: 'lyricPreview', icon: Pause, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'responseSmoothness', icon: Sparkles, daylightIconClassName: 'text-indigo-500', darkIconClassName: 'text-indigo-400' },
        { id: 'commandPaletteV2', icon: Command, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'commandPaletteQueue', icon: ListMusic, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
    ],
};
