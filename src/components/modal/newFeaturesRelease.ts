import { Box, History, Search } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_5_27',
    features: [
        { id: 'diorama', icon: Box, daylightIconClassName: 'text-violet-500', darkIconClassName: 'text-violet-400' },
        { id: 'lyricOffsetMemory', icon: History, daylightIconClassName: 'text-blue-500', darkIconClassName: 'text-blue-400' },
        { id: 'posterWallSearch', icon: Search, daylightIconClassName: 'text-emerald-500', darkIconClassName: 'text-emerald-400' },
    ],
};
