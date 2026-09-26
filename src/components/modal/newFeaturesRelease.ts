import { FileText, Film, Puzzle, Search, Wrench } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_9',
    features: [
        { id: 'lyricFiles', icon: FileText, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'videoLayer', icon: Film, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'modPlatform', icon: Puzzle, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'settingsSearch', icon: Search, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'linuxFixes', icon: Wrench, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
    ],
};
