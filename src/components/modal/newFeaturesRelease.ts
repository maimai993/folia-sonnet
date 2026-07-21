import { FlaskConical, PanelTop, Settings2, Share2 } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_1',
    features: [
        { id: 'settingsRework', icon: Settings2, daylightIconClassName: 'text-cyan-500', darkIconClassName: 'text-cyan-400' },
        { id: 'autoHideChrome', icon: PanelTop, daylightIconClassName: 'text-amber-500', darkIconClassName: 'text-amber-400' },
        { id: 'voiceInputPause', icon: FlaskConical, daylightIconClassName: 'text-emerald-500', darkIconClassName: 'text-emerald-400' },
        { id: 'obsStaticLink', icon: Share2, daylightIconClassName: 'text-violet-500', darkIconClassName: 'text-violet-400' },
    ],
};
