import { Command, ListMusic, Monitor, Sparkles, Volume2 } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_22',
    features: [
        { id: 'stillVisualizer', icon: Monitor, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'commandPaletteEnhancements', icon: Command, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'gridVisibility', icon: ListMusic, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'temperaPerformance', icon: Sparkles, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'playbackCompatibility', icon: Volume2, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
    ],
};
