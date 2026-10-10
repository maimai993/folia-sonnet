import React from 'react';
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../platform/runtime';
import type { SongResult } from '../types';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';

// 当前文件：把播放状态与元数据送到原生前台服务，换取通知栏媒体控制与后台网络保活。

/**
 * 与 FoliaPlaybackService / MainActivity 里的常量一一对应，改一处必须两处都改。
 */
const ACTION_UPDATE_METADATA = 'top.izuna.foliamajor.action.UPDATE_METADATA';
const ACTION_UPDATE_STATE = 'top.izuna.foliamajor.action.UPDATE_STATE';
const ACTION_STOP_FOREGROUND = 'top.izuna.foliamajor.action.STOP_FOREGROUND';
const ACTION_WEB_COMMAND = 'top.izuna.foliamajor.action.WEB_COMMAND';
const EXTRA_COMMAND = 'command';

type PlaybackSnapshot = 'playing' | 'paused' | 'stopped';

interface FoliaPlaybackPlugin {
  /** 启动前台服务并更新媒体元数据。artworkBase64 传 null 表示这次没有新封面。 */
  update(options: {
    title?: string;
    artist?: string;
    album?: string;
    artworkBase64?: string | null;
    /** 封面地址。原生会自己下载，用来绕开 WebView 的 CORS 限制。 */
    artworkUrl?: string | null;
    durationMs?: number;
    /** 通知栏封面角标用哪颗图标（当前播放来源的平台，本地等自家人传 'folia'）。 */
    providerBadge?: string | null;
  }): Promise<void>;
  /** 更新播放状态。playing=true 时服务会真正进入前台。 */
  setState(options: {
    state: PlaybackSnapshot;
    positionMs?: number;
    speed?: number;
  }): Promise<void>;
  /** 停止播放时收掉前台服务与通知。 */
  stop(): Promise<void>;
  /** 原生在用户点击通知栏/锁屏/耳机按键时派发的事件。 */
  addListener(
    eventName: 'foliaPlaybackCommand',
    listener: (payload: { command: string; positionMs?: number }) => void,
  ): Promise<() => void>;
}

const FoliaPlayback = registerPlugin<FoliaPlaybackPlugin>('FoliaPlayback');

// 通知栏封面：Base64 体积大，同一首歌只取一次。
const artworkCache = new Map<string, string>();
const ARTWORK_MAX_EDGE = 512;

/**
 * 把封面图片抓成 base64。
 *
 * 通知栏需要 Bitmap 而非 URL：通知由系统进程渲染，它无法访问 WebView 的
 * 缓存文件或带鉴权的资源。用 canvas 缩到 512px 再编码，避免大图撑爆 Binder 事务
 * （跨进程传输有 1MB 上限，传原始大图会 TransactionTooLargeException）。
 */
const loadArtworkAsBase64 = async (url: string): Promise<string | null> => {
  const cached = artworkCache.get(url);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (typeof createImageBitmap !== 'function') return null;

    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, ARTWORK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    // data URL 本身带前缀，原生侧会剥掉，这里原样传。
    artworkCache.set(url, dataUrl);
    // 只缓存最近的几张，避免长时间播放把内存吃满。
    if (artworkCache.size > 8) {
      const oldest = artworkCache.keys().next().value;
      if (oldest !== undefined) artworkCache.delete(oldest);
    }
    return dataUrl;
  } catch {
    // 封面拿不到不影响播放与通知，原生侧会退回默认图标。
    return null;
  }
};

/**
 * 通知栏进度条的位置刷新间隔。
 *
 * 系统按 PlaybackState 里的 position 自己往前推，但那只在速度恒定时准；
 * 缓冲、跳转、换源之后它会停在错的地方，所以这里定期校准一次。
 */
const POSITION_TICK_MS = 1000;

type UseCapacitorPlaybackBridgeOptions = {
  currentSong: SongResult | null;
  cachedCoverUrl: string | null;
  playerState: string;
  mediaSessionPlayRef: React.RefObject<() => Promise<void>>;
  mediaSessionPauseRef: React.RefObject<() => void>;
  mediaSessionPrevRef: React.RefObject<() => void>;
  mediaSessionNextRef: React.RefObject<() => Promise<void> | void>;
  /** 读当前播放时间（秒），用来让通知栏那条进度条真的往前走。 */
  getCurrentTime?: () => number;
  /** 用户拖动通知栏进度条后回传的目标位置（秒）。 */
  onSeek?: (seconds: number) => void;
};

/**
 * 把播放状态接到原生前台服务。
 *
 * 只在 Capacitor Android 下生效；Web 端与 Electron 继续用已有的
 * navigator.mediaSession 路径（见 useMediaSessionBridge）。
 */
export const useCapacitorPlaybackBridge = ({
  currentSong,
  cachedCoverUrl,
  playerState,
  mediaSessionPlayRef,
  mediaSessionPauseRef,
  mediaSessionPrevRef,
  mediaSessionNextRef,
  getCurrentTime,
  onSeek,
}: UseCapacitorPlaybackBridgeOptions): void => {
  const enabled = isCapacitorAndroid();

  // 这两个回调是每次渲染都可能换身份的内联函数，进 effect 依赖会把订阅反复重建。
  const callbacksRef = React.useRef({ getCurrentTime, onSeek });
  callbacksRef.current = { getCurrentTime, onSeek };

  // 通知栏/锁屏/耳机的控制键走这里回到 Web 层。
  React.useEffect(() => {
    if (!enabled) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void FoliaPlayback.addListener('foliaPlaybackCommand', ({ command, positionMs }) => {
      switch (command) {
        case 'play':
          void mediaSessionPlayRef.current?.();
          break;
        case 'pause':
          mediaSessionPauseRef.current?.();
          break;
        case 'next':
          void mediaSessionNextRef.current?.();
          break;
        case 'previous':
          mediaSessionPrevRef.current?.();
          break;
        case 'stop':
          mediaSessionPauseRef.current?.();
          break;
        case 'seek':
          // 拖动通知栏进度条。原生只在 actions 里带了 ACTION_SEEK_TO 时才派发这个。
          callbacksRef.current.onSeek?.(Math.max(0, (positionMs ?? 0) / 1000));
          break;
      }
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [enabled, mediaSessionPlayRef, mediaSessionPauseRef, mediaSessionPrevRef, mediaSessionNextRef]);

  // 元数据：切歌时更新一次。
  React.useEffect(() => {
    if (!enabled) return;
    if (!currentSong) {
      void FoliaPlayback.stop();
      return;
    }
    const coverUrl = cachedCoverUrl || getSongCoverUrl(currentSong) || '';
    void (async () => {
      const artworkBase64 = coverUrl ? await loadArtworkAsBase64(coverUrl) : null;
      await FoliaPlayback.update({
        title: currentSong.name || '',
        artist: getSongArtistLabel(currentSong) || '',
        album: getSongAlbumLabel(currentSong) || '',
        artworkBase64,
        // 封面地址一并给过去：WebView 里 fetch 远端封面常被 CORS 挡掉，
        // 原生下载没有这个限制，通知栏因此总能拿到对应的封面。
        artworkUrl: coverUrl || null,
        durationMs: getDurationMs(currentSong),
        providerBadge: resolveProviderBadge(currentSong),
      });
    })();
  }, [enabled, currentSong, cachedCoverUrl]);

  // 播放状态：playing 时服务进入前台，这是后台网络不被节流的关键。
  //
  // 位置必须真的传过去。原先这里写死 positionMs: 0，通知栏那条进度条于是永远停在
  // 开头 —— 看不出在播，更谈不上拖。播放中每秒校准一次：系统按 PlaybackState 自带
  // 的速度往前推，但缓冲、跳转、换源之后它会停在错的地方。
  React.useEffect(() => {
    if (!enabled) return;
    const state: PlaybackSnapshot = playerState === 'PLAYING'
      ? 'playing'
      : playerState === 'PAUSED'
        ? 'paused'
        : 'stopped';
    const push = () => {
      const seconds = callbacksRef.current.getCurrentTime?.() ?? 0;
      void FoliaPlayback.setState({
        state,
        positionMs: Math.max(0, Math.round(seconds * 1000)),
        speed: 1,
      });
    };
    push();
    if (state !== 'playing') return;
    const timer = window.setInterval(push, POSITION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, playerState, currentSong]);
};

const getDurationMs = (song: SongResult): number => {
  const candidate = (song as SongResult & { duration?: number; durationMs?: number });
  const ms = candidate.durationMs ?? candidate.duration;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0;
  // 有些音源给的是秒。
  return ms > 0 && ms < 1000 ? Math.round(ms * 1000) : Math.round(ms);
};

/**
 * 通知栏封面角标用哪颗图标。
 *
 * 通知栏封面右下角原本画的是 `android.R.drawable.ic_media_play`（那个 ▶），
 * 现在换成「这首歌来自哪个平台」的应用图标。来源只在在线歌的 sourceRef 上有，
 * 本地 / Navidrome / 舞台这些自家人一律回落 'folia' —— 原生侧没登记的值也回落 Folia。
 */
export const resolveProviderBadge = (song: SongResult | null | undefined): string => {
  const sourceRef = song?.sourceRef;
  if (sourceRef?.kind === 'online' && sourceRef.providerId) return sourceRef.providerId;
  return 'folia';
};

export { ACTION_UPDATE_METADATA, ACTION_UPDATE_STATE, ACTION_STOP_FOREGROUND, ACTION_WEB_COMMAND, EXTRA_COMMAND };
