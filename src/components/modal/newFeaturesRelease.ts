import { Clock, Sparkles, Share2, Smartphone } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_3',
    features: [
        { id: 'pendoloTheme', icon: Clock, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'obsDynamicAi', icon: Sparkles, daylightIconClassName: 'text-indigo-500', darkIconClassName: 'text-indigo-400' },
        { id: 'playerCapEnhance', icon: Share2, daylightIconClassName: 'text-emerald-500', darkIconClassName: 'text-emerald-400' },
        { id: 'safariIosFix', icon: Smartphone, daylightIconClassName: 'text-rose-500', darkIconClassName: 'text-rose-400' },
    ],
};
