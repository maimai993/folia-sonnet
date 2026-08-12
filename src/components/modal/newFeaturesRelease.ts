import { Shapes, Sparkles, Sun } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_17',
    features: [
        { id: 'sonnetSceneVariants', icon: Shapes, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'sonnetDrawingMotion', icon: Sparkles, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'equalizerDaylight', icon: Sun, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
    ],
};
