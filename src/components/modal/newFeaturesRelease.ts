import { Box, GitMerge, HardDrive, ListMusic, Palette, Search, WandSparkles } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_0',
    features: [
        { id: 'localLibraryV2', icon: HardDrive, daylightIconClassName: 'text-cyan-500', darkIconClassName: 'text-cyan-400' },
        { id: 'entityEditing', icon: GitMerge, daylightIconClassName: 'text-amber-500', darkIconClassName: 'text-amber-400' },
        { id: 'unifiedSearch', icon: Search, daylightIconClassName: 'text-emerald-500', darkIconClassName: 'text-emerald-400' },
        { id: 'metadataMatching', icon: WandSparkles, daylightIconClassName: 'text-blue-500', darkIconClassName: 'text-blue-400' },
        { id: 'dailyRecommendations', icon: ListMusic, daylightIconClassName: 'text-rose-500', darkIconClassName: 'text-rose-400' },
        { id: 'visualizerBackgrounds', icon: Palette, daylightIconClassName: 'text-fuchsia-500', darkIconClassName: 'text-fuchsia-400' },
        { id: 'dioramaRework', icon: Box, daylightIconClassName: 'text-violet-500', darkIconClassName: 'text-violet-400' },
    ],
};
