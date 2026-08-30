import { Blend, Boxes, Disc3, Radio, Timer, Wallpaper } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_1',
    features: [
        { id: 'pleiadesAutomix', icon: Blend, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'modsPlatform', icon: Boxes, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'windowsWallpaper', icon: Wallpaper, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'sleepTimer', icon: Timer, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'nowPlayingCard', icon: Disc3, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'seamlessHandover', icon: Radio, daylightIconClassName: 'text-blue-600', darkIconClassName: 'text-blue-400' },
    ],
};
