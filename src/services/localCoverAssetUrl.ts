import type { LocalSong } from '../types';
import { isValidLocalCoverAssetId, isLocalCoverWebRuntimeSupported } from './localCoverBinaryStore';

// src/services/localCoverAssetUrl.ts
// Resolves content-addressed local covers to stable Electron or same-origin Web resource URLs.

const WEB_COVER_PATH_PREFIX = '/__folia_cover/';

const hasElectronCoverProtocol = (): boolean => (
  typeof window !== 'undefined' && typeof window.electron?.hasLocalCoverAsset === 'function'
);

export const getLocalCoverAssetUrl = (assetId: string | undefined): string | null => {
  if (!isValidLocalCoverAssetId(assetId)) return null;
  if (hasElectronCoverProtocol()) {
    return `folia-cover://asset/${encodeURIComponent(assetId)}`;
  }
  if (!isLocalCoverWebRuntimeSupported()) return null;
  return `${WEB_COVER_PATH_PREFIX}${encodeURIComponent(assetId)}`;
};

export const isLocalCoverAssetUrl = (url: string | null | undefined): url is string => (
  typeof url === 'string'
  && (url.startsWith('folia-cover://asset/') || url.startsWith(WEB_COVER_PATH_PREFIX))
);

export const getPreferredLocalSongCoverUrl = (song: LocalSong): string | null => {
  const localCoverUrl = getLocalCoverAssetUrl(song.localCoverAssetId);
  return song.useOnlineCover
    ? song.onlineMetadata?.coverUrl || localCoverUrl
    : localCoverUrl || song.onlineMetadata?.coverUrl || null;
};
