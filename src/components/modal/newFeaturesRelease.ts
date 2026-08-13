import { FolderOpen, HardDrive, ListFilter, ListMusic, RefreshCw } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_6_18',
    features: [
        { id: 'm3uPlaylists', icon: ListMusic, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'gridMapBatchTools', icon: ListFilter, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'foliaIgnore', icon: FolderOpen, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'incrementalLocalScans', icon: RefreshCw, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'localCoverAssets', icon: HardDrive, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
    ],
};
