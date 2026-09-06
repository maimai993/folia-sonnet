import { AudioLines, FileAudio, Filter, FolderSync, LayoutGrid, Wallpaper } from 'lucide-react';
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
    i18nKey: 'releaseNotes.v0_7_4',
    features: [
        { id: 'latticeQueueCollage', icon: LayoutGrid, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'macWallpaperMode', icon: Wallpaper, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'transcodeFallback', icon: FileAudio, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'localFolderAutoScan', icon: FolderSync, daylightIconClassName: 'text-blue-600', darkIconClassName: 'text-blue-400' },
        { id: 'lyricFilterPersistence', icon: Filter, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'monetAudioVisibility', icon: AudioLines, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
    ],
};
