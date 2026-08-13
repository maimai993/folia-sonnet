import { isLocalCoverWebRuntimeSupported } from './localCoverBinaryStore';
import { migrateLegacyLocalCoverAssetsInBackground } from './localCoverAssetService';
import { isLocalCoverAssetUrl } from './localCoverAssetUrl';

// src/services/localCoverRuntime.ts
// Activates the Web resource route before local-library UI mounts, then starts resumable legacy migration.

export const initializeLocalCoverRuntime = async (): Promise<void> => {
  if (isLocalCoverWebRuntimeSupported() && 'serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/folia-cover-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    } catch (error) {
      console.warn('[LocalCoverAsset] Failed to register the local cover service worker', error);
    }
  }

  void migrateLegacyLocalCoverAssetsInBackground().then(() => {
    // Retry only covers that failed before their legacy payload reached external storage.
    document.querySelectorAll<HTMLImageElement>('img').forEach(image => {
      const source = image.getAttribute('src');
      if (!isLocalCoverAssetUrl(source) || image.naturalWidth > 0) return;
      image.removeAttribute('src');
      queueMicrotask(() => {
        if (image.isConnected) image.src = source;
      });
    });
  });
};
