import { useEffect } from 'react';
import type { CollectionResource } from '../core/shared/resource.contract';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { warmupSongAudio } from '../../services/prefetchService';
import { isCapacitorAndroid } from '../../platform/runtime';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// 集合宿主轻量预热首曲：订阅资源而不让分页触发首页重渲染，一次只取一首音源地址。
export const useCollectionAudioWarmup = (resource: CollectionResource | null): void => {
    useEffect(() => {
        if (!resource || !isCapacitorAndroid()) return;
        let warmed = '';
        const warm = () => {
            const first = resource.getSnapshot().tracks[0];
            if (!first || first.sourceRef?.kind !== 'online') return;
            const quality = useAudioSettingsStore.getState().audioQuality;
            const key = `${getPlaybackSongKey(first)}:${quality}`;
            if (key === warmed) return;
            warmed = key;
            void warmupSongAudio(first, quality);
        };
        const unsubscribe = resource.subscribe(warm);
        const unsubscribeSettings = useAudioSettingsStore.subscribe(warm);
        warm();
        return () => { unsubscribe(); unsubscribeSettings(); };
    }, [resource]);
};
