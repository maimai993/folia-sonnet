import { Clapperboard, Gauge, Lightbulb, ListMusic, Monitor } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_8',
    features: [
        { id: 'ponderTutorials', icon: Lightbulb, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'collectionOpenMorph', icon: Clapperboard, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'motionControls', icon: Gauge, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'wallpaperMultiMonitor', icon: Monitor, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'qqPrivatePlaylists', icon: ListMusic, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
    ],
};
