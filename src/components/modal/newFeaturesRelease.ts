import { Aperture, SlidersHorizontal } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_15',
    features: [
        { id: 'sonnetLensEffects', icon: Aperture, daylightIconClassName: 'text-fuchsia-600', darkIconClassName: 'text-fuchsia-400' },
        { id: 'sonnetPostProcess', icon: SlidersHorizontal, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
    ],
};
