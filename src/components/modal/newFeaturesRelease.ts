import { Sparkles, SunMoon } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_12',
    features: [
        { id: 'sonnetLayout', icon: Sparkles, daylightIconClassName: 'text-fuchsia-600', darkIconClassName: 'text-fuchsia-400' },
        { id: 'followSystemTheme', icon: SunMoon, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
    ],
};
