import { Command, Images, Keyboard, LayoutPanelTop, Play, WholeWord } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_3',
    features: [
        { id: 'commandPaletteUpgrade', icon: Command, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'interactionControls', icon: Keyboard, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'lyricSegmentation', icon: WholeWord, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'customPlayerControls', icon: LayoutPanelTop, daylightIconClassName: 'text-blue-600', darkIconClassName: 'text-blue-400' },
        { id: 'temperaImagePool', icon: Images, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'launchAutoplay', icon: Play, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
    ],
};
