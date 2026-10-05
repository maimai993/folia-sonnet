import { AudioLines, ListMusic, LogIn, Music2, Sparkles, WholeWord } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_13',
    features: [
        { id: 'bodian', icon: Music2, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'providerLogin', icon: LogIn, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'queueKeepOpen', icon: ListMusic, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'flacCompatibility', icon: AudioLines, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'segmentationImport', icon: WholeWord, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'lumiereTrails', icon: Sparkles, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
    ],
};
