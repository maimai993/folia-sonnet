import { Blend, ListTree, Rows3, ScrollText } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_2',
    features: [
        { id: 'smartStaffCredits', icon: ScrollText, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'sectionedSettings', icon: ListTree, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'temperaWholeLines', icon: Rows3, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'independentAutomixVisuals', icon: Blend, daylightIconClassName: 'text-blue-600', darkIconClassName: 'text-blue-400' },
    ],
};
