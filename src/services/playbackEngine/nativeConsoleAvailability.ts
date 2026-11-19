import { isNativePlayerAvailable } from './nativePlayerPlugin';
import { nativePlaybackEngine } from './nativePlaybackEngine';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import type { PlaybackRoute } from '../../types/hifi';

// Both the controls and palette must defer to the engine that actually renders PCM:
// the native plugin present, the route not hifi/external, and, when a song is loaded, an
// address the native engine takes (a blob:/data: song falls back to <audio>, which the console cannot reach).
export const canUseNativeConsole = (
    route: PlaybackRoute = usePlaybackStore.getState().playbackRoute,
    audioSrc: string | null = usePlaybackStore.getState().audioSrc,
): boolean => isNativePlayerAvailable()
    && route !== 'hifi'
    && route !== 'external'
    && (!audioSrc || nativePlaybackEngine.supports(audioSrc));

// Reactive form for components: re-renders when the route or the current song address changes.
export const useNativeConsoleAvailable = (): boolean => {
    const route = usePlaybackStore(state => state.playbackRoute);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    return canUseNativeConsole(route, audioSrc);
};
