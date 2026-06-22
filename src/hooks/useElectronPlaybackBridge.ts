import { useEffect, useState } from 'react';
import type React from 'react';
import type { RefObject } from 'react';
import type { MotionValue } from 'framer-motion';
import { PlayerState } from '../types';
import type { SongResult, LyricData } from '../types';
import type { RemoteControlCommand, RemoteControlSnapshot } from '../types/remoteControl';
import type { VideoExportState } from '../types/videoExport';
import {
    buildPlaybackSyncBridgeModel,
    buildRemoteControlSnapshotFromPlaybackSyncBridge,
    buildStagePlayerSnapshotFromPlaybackSyncBridge,
    buildTaskbarControlsFromPlaybackSyncBridge,
} from '../utils/playbackSyncBridge';
import { resolveStagePlayerPositionSec } from '../utils/stagePlayerSnapshot';

// Bridges Electron-specific shell features without coupling to UI components.
type UseElectronPlaybackBridgeOptions = {
    isElectronWindow: boolean;
    setIsTitlebarRevealed: React.Dispatch<React.SetStateAction<boolean>>;
    isPlayerChromeHidden: boolean;
    setIsPlayerChromeHidden: React.Dispatch<React.SetStateAction<boolean>>;
    showTransparentWindowBorder: boolean;
    setShowTransparentWindowBorder: React.Dispatch<React.SetStateAction<boolean>>;
    transparentPlayerBackground: boolean;
    activePlaybackContext: 'main' | 'stage';
    isStagePlayerSnapshotEnabled: boolean;
    mainWindowClickThroughEnabled: boolean;
    isNowPlayingControlDisabledRef: RefObject<boolean>;
    audioRef: RefObject<HTMLAudioElement | null>;
    audioSrc: string | null;
    currentTime: MotionValue<number>;
    duration: number;
    currentSong: SongResult | null;
    coverUrl: string | null;
    cachedCoverUrl: string | null;
    playerState: PlayerState;
    playQueue: SongResult[];
    effectiveLoopMode: 'off' | 'all' | 'one';
    isFmMode: boolean;
    isNowPlayingStageActive: boolean;
    mediaSessionPlayRef: RefObject<() => Promise<void>>;
    mediaSessionPauseRef: RefObject<() => void>;
    mediaSessionPrevRef: RefObject<() => void>;
    mediaSessionNextRef: RefObject<() => Promise<void> | void>;
    getSyntheticStageLyricsTime?: () => number;
    syncStageLyricsClock?: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    taskbarHasTrackRef: RefObject<boolean>;
    taskbarPlayerStateRef: RefObject<PlayerState>;
    exportState: VideoExportState;
    isDaylight: boolean;
    lyrics: LyricData | null;
    onRemoteExportCommand?: (command: RemoteControlCommand) => boolean;
    onExternalPlayRequest?: (request: any) => Promise<void>;
    isLiked: boolean;
    onLike?: () => void;
};

const emptyPlaybackSyncBridgeStatus = (): ElectronPlaybackSyncBridgeStatus => ({
    remoteControlOpen: false,
    discordPresenceEnabled: false,
});

export const useElectronPlaybackBridge = ({
    isElectronWindow,
    setIsTitlebarRevealed,
    isPlayerChromeHidden,
    setIsPlayerChromeHidden,
    showTransparentWindowBorder,
    setShowTransparentWindowBorder,
    transparentPlayerBackground,
    activePlaybackContext,
    isStagePlayerSnapshotEnabled,
    mainWindowClickThroughEnabled,
    isNowPlayingControlDisabledRef,
    audioRef,
    audioSrc,
    currentTime,
    duration,
    currentSong,
    coverUrl,
    cachedCoverUrl,
    playerState,
    playQueue,
    effectiveLoopMode,
    isFmMode,
    isNowPlayingStageActive,
    mediaSessionPlayRef,
    mediaSessionPauseRef,
    mediaSessionPrevRef,
    mediaSessionNextRef,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    taskbarHasTrackRef,
    taskbarPlayerStateRef,
    exportState,
    isDaylight,
    lyrics,
    onRemoteExportCommand,
    onExternalPlayRequest,
    isLiked,
    onLike,
}: UseElectronPlaybackBridgeOptions) => {
    const [playbackSyncBridgeStatus, setPlaybackSyncBridgeStatus] = useState<ElectronPlaybackSyncBridgeStatus>(() => emptyPlaybackSyncBridgeStatus());

    const resolveAudioSourceHref = (source: string | null | undefined) => {
        if (!source) {
            return '';
        }

        try {
            return new URL(source, window.location.href).href;
        } catch {
            return source;
        }
    };

    const isAudioElementUsingCurrentSource = () => {
        const audioElement = audioRef.current;
        if (!audioElement || !audioSrc) {
            return false;
        }

        const expectedSource = resolveAudioSourceHref(audioSrc);
        const currentSource = resolveAudioSourceHref(audioElement.currentSrc || audioElement.src);
        return Boolean(expectedSource && currentSource && expectedSource === currentSource);
    };

    const buildPlaybackSyncBridgeModelFromCurrentState = () => {
        const audioElement = audioRef.current;
        const isCurrentAudioSource = isAudioElementUsingCurrentSource();
        const currentTimeSec = audioElement?.currentTime ?? currentTime.get();
        const stagePositionSec = resolveStagePlayerPositionSec({
            activePlaybackContext,
            isExternalPlaybackSourceActive: isNowPlayingStageActive,
            audioCurrentTimeSec: isCurrentAudioSource ? audioElement?.currentTime : undefined,
            motionCurrentTimeSec: currentTime.get(),
            syntheticStageLyricsTimeSec: getSyntheticStageLyricsTime?.(),
        });
        const audioDurationSec = isCurrentAudioSource && Number.isFinite(audioElement?.duration) && (audioElement?.duration ?? 0) > 0
            ? audioElement?.duration ?? 0
            : 0;
        const stageDurationSec = audioDurationSec > 0 || activePlaybackContext === 'main'
            ? audioDurationSec
            : duration;

        return buildPlaybackSyncBridgeModel({
            activePlaybackContext,
            currentSong,
            playQueue,
            currentTimeSec,
            stagePositionSec,
            durationSec: duration,
            stageDurationSec,
            playerState,
            coverUrl,
            cachedCoverUrl,
            effectiveLoopMode,
            isFmMode,
            isStageActive: isNowPlayingStageActive,
            controlsDisabled: isNowPlayingControlDisabledRef.current,
            transparentModeEnabled: transparentPlayerBackground,
            mainWindowClickThroughEnabled,
            mainWindowBorderVisible: showTransparentWindowBorder,
            playerChromeHidden: isPlayerChromeHidden,
            exportState,
            isDaylight,
            isLiked,
            mainWindowWidth: window.innerWidth,
            mainWindowHeight: window.innerHeight,
        });
    };

    const buildRemoteSnapshot = (options: { includeLyrics?: boolean } = {}): RemoteControlSnapshot => {
        return buildRemoteControlSnapshotFromPlaybackSyncBridge(
            buildPlaybackSyncBridgeModelFromCurrentState(),
            { includeLyrics: options.includeLyrics, lyrics },
        );
    };

    const buildCurrentStagePlayerSnapshot = () => {
        return buildStagePlayerSnapshotFromPlaybackSyncBridge(buildPlaybackSyncBridgeModelFromCurrentState());
    };

    const publishStagePlayerPlaybackUpdate = () => {
        if (!isStagePlayerSnapshotEnabled) {
            return Promise.resolve(null);
        }

        const publishStageSnapshot = window.electron?.publishStagePlayerSnapshot;
        if (!publishStageSnapshot) {
            return Promise.resolve(null);
        }

        return publishStageSnapshot(buildCurrentStagePlayerSnapshot(), { forcePlaybackEvent: true });
    };

    useEffect(() => {
        if (!isElectronWindow) {
            setIsTitlebarRevealed(false);
            return;
        }

        const revealThreshold = 56;
        const handleMouseMove = (event: MouseEvent) => {
            const nextVisible = event.clientY <= revealThreshold;
            setIsTitlebarRevealed(prev => (prev === nextVisible ? prev : nextVisible));
        };
        const handleMouseLeave = () => setIsTitlebarRevealed(false);

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseleave', handleMouseLeave);
        };
    }, [isElectronWindow, setIsTitlebarRevealed]);

    useEffect(() => {
        if (!window.electron?.onTaskbarControl) {
            return;
        }

        return window.electron.onTaskbarControl((action) => {
            if (isNowPlayingControlDisabledRef.current || !audioRef.current || !taskbarHasTrackRef.current) {
                return;
            }

            if (action === 'previous') {
                mediaSessionPrevRef.current();
                return;
            }

            if (action === 'next') {
                void mediaSessionNextRef.current();
                return;
            }

            if (taskbarPlayerStateRef.current === PlayerState.PLAYING) {
                mediaSessionPauseRef.current();
            } else {
                void mediaSessionPlayRef.current();
            }
        });
    }, [audioRef, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, taskbarHasTrackRef, taskbarPlayerStateRef]);

    useEffect(() => {
        if (!window.electron?.updateTaskbarControls) {
            return;
        }

        void window.electron.updateTaskbarControls(
            buildTaskbarControlsFromPlaybackSyncBridge(buildPlaybackSyncBridgeModelFromCurrentState())
        ).catch((error) => {
            console.warn('[Electron] Failed to update Windows taskbar controls', error);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentSong, effectiveLoopMode, isFmMode, isNowPlayingStageActive, playQueue, playerState]);

    useEffect(() => {
        if (!isElectronWindow) {
            setPlaybackSyncBridgeStatus(emptyPlaybackSyncBridgeStatus());
            return;
        }

        void window.electron?.getPlaybackSyncBridgeStatus?.().then(status => {
            setPlaybackSyncBridgeStatus(status);
        }).catch((error) => {
            console.warn('[Electron] Failed to read playback sync bridge status', error);
        });

        return window.electron?.onPlaybackSyncBridgeStatusChanged?.(status => {
            setPlaybackSyncBridgeStatus(status);
        });
    }, [isElectronWindow]);

    useEffect(() => {
        const shouldPublishRemoteSnapshot = playbackSyncBridgeStatus.remoteControlOpen || playbackSyncBridgeStatus.discordPresenceEnabled;
        if (!shouldPublishRemoteSnapshot) {
            return;
        }

        if (!window.electron?.publishRemoteControlSnapshot) {
            return;
        }

        const publish = (options: { includeLyrics?: boolean } = {}) => {
            void window.electron?.publishRemoteControlSnapshot(buildRemoteSnapshot(options)).catch((error) => {
                console.warn('[Electron] Failed to publish remote control snapshot', error);
            });
        };

        publish({ includeLyrics: true });
        const intervalId = window.setInterval(() => publish(), 500);

        const handleResize = () => publish();
        window.addEventListener('resize', handleResize);

        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener('resize', handleResize);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cachedCoverUrl, coverUrl, currentSong, duration, effectiveLoopMode, exportState, isDaylight, isFmMode, isNowPlayingStageActive, isPlayerChromeHidden, lyrics, mainWindowClickThroughEnabled, playbackSyncBridgeStatus, playQueue, playerState, showTransparentWindowBorder, transparentPlayerBackground, isLiked]);

    useEffect(() => {
        if (!isStagePlayerSnapshotEnabled || !window.electron?.publishStagePlayerSnapshot) {
            return;
        }

        const publish = () => {
            void window.electron?.publishStagePlayerSnapshot(buildCurrentStagePlayerSnapshot()).catch((error) => {
                console.warn('[Stage] Failed to publish player snapshot', error);
            });
        };

        publish();
        const intervalId = window.setInterval(publish, 1000);

        return () => {
            window.clearInterval(intervalId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePlaybackContext, audioSrc, cachedCoverUrl, coverUrl, currentSong, duration, effectiveLoopMode, getSyntheticStageLyricsTime, isFmMode, isNowPlayingStageActive, isStagePlayerSnapshotEnabled, playQueue, playerState]);

    useEffect(() => {
        if (!window.electron?.onRemoteControlCommand) {
            return;
        }

        const runCommand = (command: RemoteControlCommand) => {
            if (onRemoteExportCommand?.(command)) {
                return;
            }

            if (command.type === 'set-main-window-border-visible') {
                setShowTransparentWindowBorder(command.visible);
                return;
            }

            if (command.type === 'set-player-chrome-hidden') {
                setIsPlayerChromeHidden(command.hidden);
                return;
            }

            if (command.type === 'open-export') {
                return;
            }

            if (command.type === 'toggle-like') {
                onLike?.();
                return;
            }

            if (isNowPlayingControlDisabledRef.current || !taskbarHasTrackRef.current) {
                return;
            }

            if (command.type === 'previous') {
                mediaSessionPrevRef.current();
                return;
            }

            if (command.type === 'next') {
                void mediaSessionNextRef.current();
                return;
            }

            if (command.type === 'pause') {
                mediaSessionPauseRef.current();
                return;
            }

            if (command.type === 'play') {
                void mediaSessionPlayRef.current();
                return;
            }

            if (command.type === 'seek') {
                const audioElement = audioRef.current;
                if (!Number.isFinite(command.time)) {
                    return;
                }

                const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : audioElement?.duration;
                const upperBound = Number.isFinite(safeDuration) && safeDuration > 0 ? safeDuration : command.time;
                const nextTime = Math.max(0, Math.min(command.time, upperBound));
                if (audioElement) {
                    audioElement.currentTime = nextTime;
                } else if (activePlaybackContext === 'stage') {
                    syncStageLyricsClock?.(nextTime, duration, taskbarPlayerStateRef.current);
                }
                currentTime.set(nextTime);
                void window.electron?.publishRemoteControlSnapshot(buildRemoteSnapshot());
                void publishStagePlayerPlaybackUpdate();
                return;
            }

            if (taskbarPlayerStateRef.current === PlayerState.PLAYING) {
                mediaSessionPauseRef.current();
            } else {
                void mediaSessionPlayRef.current();
            }
        };

        return window.electron.onRemoteControlCommand(runCommand);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePlaybackContext, audioRef, currentTime, duration, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, onRemoteExportCommand, setIsPlayerChromeHidden, setShowTransparentWindowBorder, syncStageLyricsClock, taskbarHasTrackRef, taskbarPlayerStateRef, onLike]);

    useEffect(() => {
        if (!window.electron?.onStagePlayerControlRequest) {
            return;
        }

        const complete = (requestId: string, ok: boolean, error?: unknown) => {
            void window.electron?.completeStagePlayerControlRequest?.({
                requestId,
                ok,
                error: ok ? null : error instanceof Error ? error.message : String(error),
            });
        };

        return window.electron.onStagePlayerControlRequest((request) => {
            try {
                if (isNowPlayingControlDisabledRef.current || !taskbarHasTrackRef.current) {
                    throw new Error('Player controls are disabled in the current context.');
                }

                if (request.action === 'prev') {
                    mediaSessionPrevRef.current();
                    complete(request.requestId, true);
                    return;
                }

                if (request.action === 'next') {
                    void Promise.resolve(mediaSessionNextRef.current()).then(() => complete(request.requestId, true)).catch(error => complete(request.requestId, false, error));
                    return;
                }

                if (request.action === 'pause') {
                    mediaSessionPauseRef.current();
                    complete(request.requestId, true);
                    return;
                }

                if (request.action === 'resume') {
                    void mediaSessionPlayRef.current().then(() => complete(request.requestId, true)).catch(error => complete(request.requestId, false, error));
                    return;
                }

                if (request.action === 'seek') {
                    const nextTime = Math.max(0, (request.positionMs ?? 0) / 1000);
                    if (audioRef.current) {
                        audioRef.current.currentTime = nextTime;
                    } else if (activePlaybackContext === 'stage') {
                        syncStageLyricsClock?.(nextTime, duration, taskbarPlayerStateRef.current);
                    }
                    currentTime.set(nextTime);
                    void publishStagePlayerPlaybackUpdate()
                        .then(() => complete(request.requestId, true))
                        .catch(error => complete(request.requestId, false, error));
                    return;
                }

                throw new Error(`Unsupported Stage player control action: ${request.action}`);
            } catch (error) {
                complete(request.requestId, false, error);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePlaybackContext, audioRef, currentTime, duration, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, syncStageLyricsClock, taskbarHasTrackRef, taskbarPlayerStateRef]);

    useEffect(() => {
        if (!window.electron?.onStageExternalPlayRequest || !onExternalPlayRequest) {
            return;
        }

        return window.electron.onStageExternalPlayRequest((request) => {
            void onExternalPlayRequest(request);
        });
    }, [onExternalPlayRequest]);

    return {
        publishStagePlayerPlaybackUpdate,
    };
};
