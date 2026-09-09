import { HardDrive, Images, Languages, Radio } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_7',
    features: [
        { id: 'qqPlaybackReliability', icon: Radio, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'localLibraryCovers', icon: HardDrive, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'embeddedLyricTracks', icon: Languages, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'latticeArtworkEfficiency', icon: Images, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
    ],
};
