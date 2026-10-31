import React from 'react';
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../platform/runtime';
import type { SongResult } from '../types';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { nativePlaybackEngine } from '../services/playbackEngine/nativePlaybackEngine';
import { applyNativeLikeOverrides, omni, type NativeLikeOverrideInput } from '../services/onlineMusic/omni';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { buildQueueMirrorEntries, getMirrorDurationMs, resolveLikeIdentity } from '../utils/queueMirrorEntry';
import type { NativeQueueState } from '../services/nativeQueueBridge';
import { isNativePlaybackReconciling } from '../services/playbackEngine/nativePlaybackSync';
import { useNativePlaybackReconciliation } from './useNativePlaybackReconciliation';

// 当前文件：把播放状态与元数据送到原生前台服务，换取通知栏媒体控制与后台网络保活。
//
// 分工（原生为真源）：通知栏那张封面由原生按 artworkUrl 自己下载（没有 CORS 限制，
// 也不吃 WebView 冻结）；JS 不再抓 base64 —— 拉取的活全归原生，JS 只在醒来时
// 「问原生要当前的状态」（getPlaybackSnapshot）把自己对齐过去。

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
  /** 启动前台服务并更新媒体元数据。封面由原生按 artworkUrl 自己下载，不经 JS。 */
  update(options: {
    title?: string;
    artist?: string;
    album?: string;
    /** 封面地址。原生会自己下载，用来绕开 WebView 的 CORS 限制。 */
    artworkUrl?: string | null;
    durationMs?: number;
    /** 通知栏封面角标用哪颗图标（当前播放来源的平台，本地等自家人传 'folia'）。 */
    providerBadge?: string | null;
    /**
     * 当前这首歌的身份。
     *
     * 原生拿它跟上一首比：不一样就是换歌了，先把上一首的封面丢掉。没有它就分不清
     * 「这首歌没有封面」和「还没拿到封面」——后一种情况下旧封面会被一直挂着，
     * 通知栏于是先画出上一首的图，等原生按 URL 下载完才换成当前的。
     */
    songKey?: string | null;
    /**
     * 这首歌是不是「已喜欢」：通知栏那颗心画实心还是空心就看它。
     * 不传 = 这次不改（原生保留上一个值）。
     */
    liked?: boolean | null;
    /**
     * 「喜欢」这个动作现在能不能用。false 时通知栏干脆不画那颗心 —— 通知按钮没有置灰，
     * 画出来点了没反应比不画更让人困惑。不传 = 这次不改。
     */
    canLike?: boolean | null;
    /**
     * 红心的原生兜底：当前歌来自哪个平台、平台侧的歌曲 id。
     * WebView 冻结时通知栏那颗心按它直接对各平台补写收藏（kugou 等没有原生通道会跳过）。
     */
    providerId?: string | null;
    serverSongId?: string | null;
  }): Promise<void>;
  /** 更新播放状态。playing=true 时服务会真正进入前台。 */
  setState(options: {
    state: PlaybackSnapshot;
    positionMs?: number;
    speed?: number;
  }): Promise<void>;
  /** 停止播放时收掉前台服务与通知。 */
  stop(): Promise<void>;
  /**
   * 队列快照：WebView 冻结后通知栏切歌的原生兜底数据源。
   * 推**全量队列**（每条带平台身份，不带地址 —— 地址由原生平台网关按需解析，
   * 也有预取缓存），index 是当前歌的下标。队列本体只在队列真的变了时才推。
   */
  setQueueMirror(options: { queueJson: string; index: number }): Promise<void>;
  /** 队列没变、只是换了一首正播的：轻量推游标，不过大 JSON。 */
  setQueueMirrorIndex(options: { index: number }): Promise<void>;
  /**
   * 问原生要当前的状态（原生是播放的真源）。
   * WebView 冻结期间通知栏的镜像换源、原生补写红心都发生在原生侧，JS 醒来后
   * 第一件事是拉这份快照对齐自己的队列 / 位置 / 红心，而不是推旧状态过去。
   *
   * **返回的是快照本身，不是 `{ snapshot }`**：原生那边 `getPlaybackSnapshot`
   * 直接 `call.resolve(snapshotJson())`（FoliaPlaybackPlugin.kt）。这里以前写成
   * `{ snapshot: {...} }`，于是调用方 `const { snapshot } = ...` 拿到 undefined、
   * 第一轮就 `return true` 退出 —— 整个「启动时认领原生正在放的那首」的 effect
   * 一次都没真正跑过。
   */
  getPlaybackSnapshot(): Promise<{
    hasSong: boolean;
    songKey: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    positionMs: number;
    playing: boolean;
    liked: boolean;
    canLike: boolean;
    providerId: string;
    serverSongId: string;
    artworkUrl: string;
  }>;
  /**
   * 两轨合一：App 内点歌 / 切歌全走原生桥执行。
   * 原生先把调用者手里最新的队列落进镜像，再找这首歌：地址有缓存直接放，
   * 没有就按需解析后放。回 ok=false（原生没激活 / 定位不到）时调用方回退 Web 全流程。
   */
  playFromQueue(options: { songKey: string; queueJson: string; index: number }): Promise<{ ok: boolean }>;
  /**
   * 上下首分流：原生在镜像里定位当前首的相邻一首直接放。
   * skipped=false 表示定位不到相邻首（队列到头 / FM / 原生没激活），调用方回退 Web 逻辑。
   */
  requestSkip(options: { direction: number }): Promise<{ skipped: boolean }>;
  /**
   * 原生补写过的红心（WebView 冻结期间通知栏那颗心在服务器上写成功的）。
   * App 启动时取走一次，对齐进账号缓存，App 里的心才不会与通知栏打架。
   */
  consumeLikeOverrides(): Promise<{ overrides: NativeLikeOverrideInput[] }>;
  /**
   * 原生在用户点击通知栏/锁屏/耳机按键时派发的事件。
   *
   * 返回的是 Capacitor 的监听句柄对象 `{ remove }`，**不是函数** —— 当成函数调用会
   * 抛 `xxx is not a function`，而它发生在 effect 的清理里，React 会因此卸载整棵树，
   * 表现为一进播放器就黑屏。
   */
  addListener(
    eventName: 'foliaPlaybackCommand',
    listener: (payload: { command: string; positionMs?: number; songKey?: string }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
  /**
   * 原生拉到的歌词。**歌词的拉取归原生**：它知道当前该是哪首（队列在它手里），
   * 拉到就推过来，播放页只按 songKey 认领并渲染。
   *
   * 以前歌词是 JS 自己按 currentSong 的 effect 拉的，而原生派发的点歌绕过那个 effect，
   * 于是「切了歌单，歌词还停在上一个歌单那首」。
   */
  addListener(
    eventName: 'foliaPlaybackLyrics',
    listener: (payload: { songKey: string; lrc?: string; translated?: string }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
}

const FoliaPlayback = registerPlugin<FoliaPlaybackPlugin>('FoliaPlayback');

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
  /** 当前这首歌是不是「已喜欢」：通知栏那颗心的形状跟它走。 */
  isLiked?: boolean;
  /** 「喜欢」现在能不能用；false 时通知栏不画那颗心。 */
  canLike?: boolean;
  /** 通知栏 / 锁屏 / 耳机那颗心被按下。与面板里的喜爱按钮同一个动作。 */
  onToggleLike?: () => void;
  /**
   * 原生兜底切歌后 JS 的认领：把队列跳到原生正在放的那首（按 songKey 找），
   * 找到并接管了回 true（positionMs 是原生此刻的位置，接管后对齐过去）；
   * 队列还没恢复 / 找不到这首歌回 false，调用方会重试。
   * 不认领的话，App 打开时队列还停在旧歌上，与通知栏各说各话。
   */
  onSyncToSong?: (songKey: string, positionMs?: number, playing?: boolean) => boolean | void;
  onNativeSnapshot?: (snapshot: NativeQueueState) => boolean | Promise<boolean>;
  /**
   * 两轨合一的失败回执：原生解析这首歌的播放地址失败。调用方把歌拉黑并回退
   * Web 全流程（playSong 直通），不重试不卡住。
   */
  onNativePlayFailed?: (songKey: string) => void;
  /** 队列快照：原生兜底切歌的数据源。缺省时不推。 */
  queue?: SongResult[];
  /** 当前这首歌已解析的播放地址（audioSrc）。 */
  currentAudioUrl?: string | null;
  /**
   * 每条队列条目的红心状态（同步读账号缓存，不发网络）：全量队列每一条都带，
   * 原生兜底切到哪一首，通知栏那颗心都不会消失。
   */
  likeStateOf?: (song: SongResult) => { liked: boolean; canLike: boolean } | undefined;
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
  isLiked = false,
  canLike = false,
  onToggleLike,
  queue,
  currentAudioUrl,
  likeStateOf,
  onSyncToSong,
  onNativeSnapshot,
  onNativePlayFailed,
}: UseCapacitorPlaybackBridgeOptions): void => {
  const enabled = isCapacitorAndroid();

  // 这三个回调是每次渲染都可能换身份的内联函数，进 effect 依赖会把订阅反复重建。
  const callbacksRef = React.useRef({ getCurrentTime, onSeek, onToggleLike, onSyncToSong, onNativePlayFailed });
  callbacksRef.current = { getCurrentTime, onSeek, onToggleLike, onSyncToSong, onNativePlayFailed };

  // 原生补写的红心，App 这边开机认领：把账号缓存（likedSongIds）对齐到原生写入的
  // 服务器真状态。不认领的话，打开 App 那一刻 JS 推的还是旧缓存，通知栏那颗心会被
  // 它翻回去（原生侧有真源守卫拦着通知栏，但 App 里的心也对不上）。
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void FoliaPlayback.consumeLikeOverrides()
      .then(({ overrides }) => {
        if (cancelled || !overrides || overrides.length === 0) return;
        applyNativeLikeOverrides(overrides);
      })
      .catch(() => {
        // 老版本原生没有这个方法：没有记录就没有可对齐的，静默跳过。
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // 一份完整原生快照包含队列、歌曲、时钟及暂停状态；认领完成前不回写旧状态。
  const { pending: reconciling, refresh: refreshNative } = useNativePlaybackReconciliation(snapshot => (
    onNativeSnapshot?.(snapshot)
      ?? Boolean(callbacksRef.current.onSyncToSong?.(snapshot.songKey, snapshot.positionMs, snapshot.playing))
  ));

  // 通知栏/锁屏/耳机的控制键走这里回到 Web 层。
  React.useEffect(() => {
    if (!enabled) return;
    let dispose: { remove: () => Promise<void> | void } | undefined;
    let cancelled = false;
    void FoliaPlayback.addListener('foliaPlaybackCommand', ({ command, positionMs, songKey }) => {
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
        case 'like':
          // 通知栏 / 锁屏 / 耳机那颗心（原生播放未激活时才走这条路）。
          // 与面板里的喜爱按钮同一个 handleLike：能不能用、成功与否、状态怎么存
          // 都归 Web 层那一份判断。状态变了会随下一次元数据推送回到通知栏。
          callbacksRef.current.onToggleLike?.();
          break;
        case 'likeDone':
          /*
           * 原生播放激活时通知栏那颗心由原生直接写（0 延迟亮心，见
           * FoliaPlaybackService.handleTransportLike），这里只做对齐：
           * 把原生写入的补写记录领回来更新账号缓存，App 里那颗心跟着变。
           * 故意不调 onToggleLike —— 它会再写一遍平台，两次写状态翻两遍等于没点。
           */
          void FoliaPlayback.consumeLikeOverrides()
            .then(({ overrides }) => {
              if (overrides && overrides.length > 0) applyNativeLikeOverrides(overrides);
            })
            .catch(() => undefined);
          break;
        case 'syncTo':
          // 原生兜底切歌后的认领：把队列跳到原生正在放的那首（守卫期间旧歌的
          // metadata 会被原生拒收，见 FoliaPlaybackService.updateMetadata）。
          // 原生切歌是直接起播的，所以这里不带 playing（默认视为在播）。
          refreshNative();
          break;
        case 'nativePlayFailed':
          // 两轨合一的失败回执：原生按需解析地址失败（URL 为 null）。JS 把这首歌
          // 拉黑（本次会话内不再分流给它）并回退 Web 全流程自己放，不卡住不重试。
          if (songKey) callbacksRef.current.onNativePlayFailed?.(songKey);
          break;
        case 'repeatRestart':
          // 单曲循环重播（原生在放时 ExoPlayer 无缝回绕，不发 ended）。**故意没有
          // 动作**：进度基准的复位在原生自己那条事件链上（引擎 onPositionDiscontinuity
          // 发 seeked，插件复位 lastDeliveredMs），Web 的 rAF 时钟读原生位置自然跟上。
          // 这里写出来是让后人知道这条命令收到了、并且**什么都不该做**——
          // 在这里再 set currentTime 反而会与原生时钟打架。
          break;
      }
    }).then((handle) => {
      // handle 是 Capacitor 的监听句柄 `{ remove }`，不是函数。
      if (cancelled) void handle.remove();
      else dispose = handle;
    });
    return () => {
      cancelled = true;
      void dispose?.remove();
    };
  }, [enabled, mediaSessionPlayRef, mediaSessionPauseRef, mediaSessionPrevRef, mediaSessionNextRef]);

  // 元数据：切歌时更新一次。
  //
  // 封面只给地址，抓取完全归原生（fetchArtwork 按 URL 下载，没有 CORS 限制，
  // 也不吃 WebView 冻结）。JS 抓 base64 那条路整个删了 —— 它每首歌多一趟
  // canvas 编码、多占一份桥的吞吐，而原生下载本来就更快更稳。
  React.useEffect(() => {
    if (!enabled || reconciling || isNativePlaybackReconciling()) return;
    if (!currentSong) {
      void FoliaPlayback.stop();
      return;
    }
    const coverUrl = cachedCoverUrl || getSongCoverUrl(currentSong) || '';
    const songKey = getPlaybackSongKey(currentSong);
    const likeIdentity = resolveLikeIdentity(currentSong);
    void FoliaPlayback.update({
      title: currentSong.name || '',
      artist: getSongArtistLabel(currentSong) || '',
      album: getSongAlbumLabel(currentSong) || '',
      artworkUrl: coverUrl || null,
      durationMs: getMirrorDurationMs(currentSong),
      providerBadge: resolveProviderBadge(currentSong),
      songKey,
      liked: isLiked,
      canLike,
      providerId: likeIdentity.providerId || null,
      serverSongId: likeIdentity.serverSongId || null,
    });
  }, [enabled, currentSong, cachedCoverUrl, isLiked, canLike, reconciling]);

  // 网易 uid 推给原生：原生兜底切歌后要拉「我喜欢」名单对红心（uid 只在 Web 层的
  // 账号缓存里，cookie 里没有）。登录 / 登出（账号 store 变化）都会跟着推一遍。
  // 其余平台的凭据推送走 omni 统一入口同步（每家 provider 自己实现），这里不点名；
  // 启动先推一遍，队列镜像每推一次也顺手同步。
  React.useEffect(() => {
    if (!enabled) return;
    const push = () => {
      if (typeof window === 'undefined') return;
      const plugin = (window as any).Capacitor?.Plugins?.FoliaNative;
      if (!plugin?.setGatewayCredentials) return;
      const account = useOnlineProviderAccountStore.getState().accounts['netease'];
      const uid = account?.user?.id;
      void plugin
        .setGatewayCredentials({ provider: 'netease', userId: uid == null ? '' : String(uid) })
        .catch(() => undefined);
      omni.syncNativeGatewayCredentials();
    };
    push();
    const unsubscribe = useOnlineProviderAccountStore.subscribe(push);
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [enabled]);

  // 队列快照：WebView 冻结后通知栏切歌的唯一依据。
  //
  // 推**全量队列**而不是「当前 ±10」的窗口：地址不再随条目带（原生平台网关按需
  // 解析，当前这首歌也有预取），窗口就成了人为的天花板 —— 连切几首就到头
  // （用户报的「下一首了五首就下不去了」），而网关面前队列里每一首都是平等的。
  // 每一条都带平台身份（网易 id / QQ songmid / 酷狗 hash）与红心状态（likeStateOf
  // 同步读账号缓存），原生兜底切到哪一首，那颗心都不会消失。
  //
  // 全量 JSON 一推几百 KB，桥只有一条 —— 所以只在**队列本体变化**时推；
  // 换歌只走下面那个轻量游标 effect。likeStateOf 是内联函数（每次渲染都是新身份），
  // 不进依赖；但它读的那份红心状态要有个稳定的信号，否则账号里的红心变了、
  // Navidrome 收藏刷新了，队列本体没变就再也不推 —— 原生兜底切过去那颗心是旧的。
  const likeSignal = React.useMemo(
    () => (queue ?? []).map((song) => {
      const state = likeStateOf?.(song);
      return `${getPlaybackSongKey(song)}|${state?.liked ? 1 : 0}${state?.canLike === false ? 0 : 1}`;
    }).join(','),
    [queue, likeStateOf],
  );
  const mirrorSourceRef = React.useRef({ queue, likeStateOf, currentSong });
  mirrorSourceRef.current = { queue, likeStateOf, currentSong };
  React.useEffect(() => {
    if (!enabled || reconciling || isNativePlaybackReconciling()) return;
    const { queue: list, likeStateOf: stateOf, currentSong: activeSong } = mirrorSourceRef.current;
    if (!list || list.length === 0) return;
    // 飞牛的凭据要在队列之前到位：登录可能发生在插件可用之前（重启后桥晚一步），
    // 这里每推一次队列顺手同步一遍 —— 一次几十字节的调用，换原生兜底不空手。
    // 走 omni 而不是直连 transport：hooks 按依赖方向只该经过 omni。
    omni.syncNativeGatewayCredentials();
    const entries = buildQueueMirrorEntries(list, stateOf);
    const index = activeSong ? list.findIndex((song) => getPlaybackSongKey(song) === getPlaybackSongKey(activeSong)) : -1;
    void FoliaPlayback.setQueueMirror({ queueJson: JSON.stringify(entries), index });
    // likeSignal 不进依赖数组的「语义」，只当「红心状态变了」的触发器用。
    // eslint 层面它确实被 effect 体间接读到，所以照实列上。
  }, [enabled, queue, likeSignal, reconciling]);

  // 游标：队列没变、换了一首正播的。几百 KB 的全量 JSON 不跟着切歌过桥。
  React.useEffect(() => {
    if (!enabled || reconciling || isNativePlaybackReconciling() || !currentSong || !queue || queue.length === 0) return;
    const index = queue.findIndex((song) => getPlaybackSongKey(song) === getPlaybackSongKey(currentSong));
    if (index < 0) return;
    void FoliaPlayback.setQueueMirrorIndex({ index });
  }, [enabled, currentSong, queue, reconciling]);

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
      // 原生接管时状态也归原生，不能用恢复中的 Web 播放态覆盖它。
      if (reconciling || isNativePlaybackReconciling() || nativePlaybackEngine.ownsPlayback()) return;
      const seconds = callbacksRef.current.getCurrentTime?.() ?? 0;
      void FoliaPlayback.setState({
        state,
        positionMs: Math.max(0, Math.round(seconds * 1000)),
        speed: 1,
      });
    };
    /*
     * 只有**播放 / 暂停翻转**和挂载时推一次状态。位置那一拍下面单独判断。
     */
    push();
    if (state !== 'playing') return;
    /*
     * ⭐ 位置那一拍：**原生播放器接管的那一首一次都不推。**
     *
     * 掉帧打点量出来的是「每秒一次、每次 80~290ms」的主线程阻塞，而这里正好是
     * 每秒一次 —— 每一笔都是一次 `startService` 的 IPC，服务的 `onStartCommand`
     * **跑在 App 的主线程上**，里面还要 `mediaSession.setPlaybackState()`（同步
     * Binder 给 system_server 与所有 MediaController）。掉帧那一刻堆内存纹丝不动
     * （28MB 恒定），所以不是 GC，就是主线程在等这次跨进程调用。
     *
     * 而这一推在原生播放时**没有任何收益**：服务那边 `resolvePlaybackPositionMs()`
     * 在原生在播时直接问播放器，写进去的 `cachedPositionMs` 在那条分支上不参与
     * 计算（全服务只有一处读取，就是它的兜底分支）。后台节流那个顾虑同样不成立 ——
     * 它跑在原生侧，不吃 WebView 的定时器节流。
     *
     * 原生接管时播放态同样由原生状态边界刷新；Web 只在 <audio> 回落路径推送。
     */
    const timer = window.setInterval(() => {
      if (nativePlaybackEngine.ownsPlayback()) return;
      push();
    }, POSITION_TICK_MS);
    /*
     * 再补一条由播放器事件驱动的：**后台的定时器会被 Chromium 节流**（页面既不可见、
     * WebView 里又已经没有音频在响，会掉进「intensive throttling」，1 秒变 1 分钟）。
     * 靠上面那个 setInterval 推位置，通知栏在后台上就永远是同一个数字。
     * 原生播放器只在状态边界发事件（不再按 250ms 推位置），这里只把它当成
     * 「后台也能跑的一拍」；原生接管时下面会直接返回，服务自己问播放器。
     *
     * ⚠️ 但**只在网页播放（`<audio>`）时**才真的推 —— 原生接管的那一首服务自己会问
     * 播放器，这一推纯属浪费（见下面 `ownsPlayback()` 那一处的说明）。
     */
    let lastPushAt = 0;
    const stopFollowingEngine = nativePlaybackEngine.subscribe(() => {
        /*
         * ⭐ **原生播放器接管的那一首，这一路一次都不推。**
         *
         * 服务那边 `FoliaPlaybackService.resolvePlaybackPositionMs()` 在原生在播时
         * **直接问播放器**（`FoliaNativePlayerPlugin.currentPositionMs()`）：比这里
         * 插值出来的更准，而且它跑在原生侧，**根本不吃 WebView 的定时器节流** ——
         * 上面那条注释担心的「后台通知栏不动」，靠的就是它，不需要 Web 顶这一下。
         * 也就是说这一推对进度条没有任何贡献（写进去的 cachedPositionMs 在原生在播
         * 时压根不参与计算），只有代价：
         *   · 一次 `startService` 的 IPC，服务 `onStartCommand` 还要重建一次
         *     MediaSession 的 PlaybackState（跨进程广播给系统 UI / 蓝牙 / Auto）；
         *   · 而 **Capacitor 的桥只有一条** —— 500ms 一笔正好把界面定期顶一下，
         *     表现就是「App 里隔一会儿顿一下，像在等什么东西」。
         *
         * 网页播放（`<audio>`）时不走这里，那条路只有播放器自己知道位置，照旧推。
         *
         * ⚠️ 只挡**位置**这一路：播放 / 暂停翻转是上面那个 effect 推的（依赖
         * playerState），服务要靠它认状态，那条不能省。
         */
        if (nativePlaybackEngine.ownsPlayback()) return;
        const now = Date.now();
        if (now - lastPushAt < 500) return;
        lastPushAt = now;
        push();
    });
    return () => {
        window.clearInterval(timer);
        stopFollowingEngine();
    };
  }, [enabled, playerState, currentSong, reconciling]);
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
// 两轨合一：点歌 / 切歌的分流（usePlaybackQueueController）也走同一个插件句柄。
export { FoliaPlayback };
