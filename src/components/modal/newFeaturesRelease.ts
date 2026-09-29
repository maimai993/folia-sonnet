import { Layers3, Maximize2, Sparkles } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_10',
    features: [
        { id: 'lumiere', icon: Sparkles, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'gridTransitions', icon: Layers3, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'fullscreenButton', icon: Maximize2, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
    ],
};
