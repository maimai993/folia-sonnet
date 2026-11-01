# 原生主导架构

> 目标：**播放链路的真相在原生，WebView 只负责同步状态、渲染界面、处理交互。**
>
> 这不是一次重构，是换主人。下面写清换完之后谁负责什么、以及为什么。

## 为什么必须换

现在 WebView 持有播放链路的真相：队列、当前曲目、循环模式、播放状态。原生只是被前台
驱动的一个执行器，靠 `mirroredQueueJson` 和前台下发的命令干活。

后果在真机上一条条暴露，但其实是同一个根因：

| 现象 | 同一根因下的解释 |
|---|---|
| 前台被冻结时暂停后无法继续播放 | 播放状态机在 JS 里，进程冻结后 JS 不跑，没人接住恢复 |
| 单曲循环放完停在末尾 | 回绕时不换源、不重置位置，而位置基准也由前台那条链路维护 |
| 切歌单后音源、歌词、主题都不换 | 这些派生行为挂在 `currentSong` 的 React effect 上，同一个源头 |
| 自动横屏没生效 | 判定依赖前台 store 的三项设置，任何一项不满足就静默返回 null |

逐条打补丁修不完 —— 每次修完，换个入口换个时序又会冒出来。#85/#86/#87 三个修复真机
全部无效，就是这个判断的证据。

## 新的职责划分

### 原生（Kotlin）—— 唯一真相

| 域 | 内容 | 位置 |
|---|---|---|
| 设置 | 全部设置项，一份 JSON 落盘 | `settings/FoliaSettingsStore.kt` |
| 播放队列 | 队列、下标、循环模式、随机、切歌、放完往哪走 | `player/NativePlayQueue.kt` |
| 音频地址 | 向平台要地址、失败重试、预取邻居 | `online/MusicGateway.kt`（已具备） |
| 歌词 | 拉取、缓存、随曲目变化下发 | 新增 `player/NativeLyricFetcher.kt` |
| 凭据 | 平台登录态，经 `CookieManager` 落盘 | `FoliaNativePlugin.storeResponseCookies`（已具备） |
| 主题参数 | AI 补全的端点解析、三协议请求、参数降级 | `ai/AiCompletion.kt` + `ai/AiEndpoints.kt` |
| 播放状态 | 播放/暂停/缓冲/错误，自己维持 | `FoliaPlaybackService.kt` |

### WebView（JS）—— 只做三件事

1. **同步状态**：启动时拉一次设置与播放快照，之后订阅原生的推送。
2. **渲染界面**：按拿到的快照画播放页、队列、歌词、主题。
3. **处理交互**：把用户动作翻成一个意图下发（播放这个队列、切这首、设成单曲循环）。

JS 里**不保留业务逻辑**：不做「上一首是什么」的推断、不做循环模式的判断、不做失败后的
重试决策、不决定歌词什么时候该重新拉。这些都是原生的事。

## 契约

字段名与 Web 侧现有存储键保持一致，避免两边各有一份默认值。

### 设置

```ts
// 原生 → 前台：启动时、以及任何一次改动之后
type SettingsSnapshot = { [key: string]: unknown }

// 前台 → 原生
setSettings({ values: Record<string, unknown> })   // 整份或部分，合并写入
getSettings() -> SettingsSnapshot
```

### 播放

```ts
// 前台 → 原生（意图）
playQueue({ entries, index })        // 换队列并开始播：整份替换，不在旧队列上修补
setLoopMode({ mode, shuffle })       // 循环模式归原生，前台只下发
skip({ direction })                   // ±1
seek({ positionSec })
pause() / resume()

// 原生 → 前台（状态推送，事件名 foliaPlaybackState）
type PlaybackState = {
  entries: QueueEntry[]
  index: number
  loopMode: 'off' | 'all' | 'one'
  shuffle: boolean
  revision: number      // 变了就是新快照，前台整体重画
  status: 'playing' | 'paused' | 'buffering' | 'error' | 'idle'
  positionSec: number
  durationSec: number
  songKey: string
}
```

`revision` 是关键：前台不用逐字段比，拿到就整体重画。逐字段做增量推断正是
「歌词/主题跟不上」的来源。

### 歌词

```ts
// 原生 → 前台：曲目变了就推一次，前台不用自己判断该不该重新拉
type LyricPayload = { songKey: string; lrc: string | null; translated: string | null }
```

## 迁移顺序

一次做完不可验证，按依赖从上到下推：

1. **设置存储**（`FoliaSettingsStore`）—— 一切的基础，已建
2. **队列状态机**（`NativePlayQueue`）—— 不碰播放器，可单测，已建
3. **播放服务接入队列状态机** —— 自动下一首、循环、随机改由原生决定，已接入
   （`playFromQueue` 整份替换队列；镜像推送用 `syncEntries` 保下标跟进插删歌）
4. **歌词拉取下沉** —— 曲目变化即推，已做（服务里 `fetchLyricForNativePlayback`
   拉到后经 `FoliaPlaybackPlugin.dispatchLyrics` 推给前台，前台按 songKey 认领）
5. **错误重试下沉** —— 地址解析失败原生退避重试（0/400/1200ms），仍失败按
   「自动跳过无法播放的歌曲」跳过或停下（`decideOnUnplayable`，连续 5 首封顶），已做
6. **主题跟随** —— 前台按 songKey 变化恢复主题（`useSongThemeFollow`），不再依赖
   「走哪条路径切的歌」，已做
7. **Web 侧瘦身** —— 点歌/切歌分流给原生、歌词订阅、横屏可见性上报，已做
8. **自动横屏** —— 改由原生按设置自己决定（`PhoneLayoutOrientation.resolve`），
   前台只上报「在不在播放页」，已做

9. **AI 补全下沉** —— 三套协议（OpenAI 兼容 / Anthropic / Gemini）的请求拼装、发送、
   参数降级重试、响应解析全在原生（`ai/AiCompletion.kt`）：凭据由 Web 推给原生只存
   原生（`FoliaNative.setAiConfig` → `FoliaSettingsStore`），补全经
   `FoliaNative.runAiCompletion` 整条在原生跑 —— WebView 冻结不再影响生成中的请求。
   老版本 App / 非安卓回落原路（`aiNativeFetch`，HTTP 仍走原生 OkHttp，只是发起那一刻
   需要 JS 活着），已做
10. **AI 云缓存** —— 拉取（`fetchAiCacheViaNative` → `aiCloudCacheGet`）与回传
   （`createAiFetch` → `aiRequest`）的 HTTP 都在原生 OkHttp；回传时机在生成完成后、
   由 Web 编排（它必须拿到生成结果才知道该回传什么），这部分编排留在 Web 是契约使然，
   不是缺口，已做

11. **后台失败与续播自主** —— WebView 冻结时由原生自己处理：
   - 自然结束：插件 `ended` 带 `songKey`（即 MediaItem `mediaId`），服务 `onTrackFinished(songKey)`
     只在它与当前曲 / 待派发曲一致时前进；空串视为「没带身份」，退回旧的时间窗去重。
   - 播放错误：后台（`FoliaPlaybackService.appUiVisible == false`）按设置 `backgroundSilentSkip`
     （默认开）静默跳下一首，不通知 Web；连续 5 首封顶后暂停。前台仍只发 `nativePlayFailed`，
     由 Web 决定。判定在 `player/NativeFailurePolicy.kt`。
   - 派发中的曲目记在 `pendingDispatchSongKey`，到达后由快照清除；派发终止（封顶 / 无下一首）也清除，
     避免旧曲恢复后的快照与 `ended` 被丢掉。
12. **大队列镜像** —— `setQueueMirror` 不再把整份 JSON 塞进 Intent extra（超 Binder 1MB 会抛），
   插件进程内暂存（`stageQueueMirror`），Intent 只带 `EXTRA_QUEUE_MIRROR_STAGED`。
13. **后台主题** —— `ai/BackgroundThemeWorker.kt` 在切歌且拿到歌词后，于原生先查云缓存、未命中再用
   `AiCompletion` 生成并应用叠层；Web 经 `FoliaNative.getBackgroundThemeResult({ songKey, policy, lyricText })`
   认领，结果按歌曲、policy、歌词指纹、配置与 AI 指纹逐项校验，任一不符返回空对象。
14. **显示时钟** —— `FoliaNativePlayer.getSnapshot()` 增加 `buffering`、`speed`；`seeked` 事件附带
   `playing` / `buffering`。亮屏与叠层自检调用 `refreshDisplayAnchor()`，只读真实播放器位置
   重设显示锚点，不 seek、不重新 prepare。

## 尚未迁移

- **随机播放的尾部重排**（App 内点歌那一次 `shuffleQueue`）：行为与原生一致，仅路径
  还在 Web —— 无行为差异，暂不动

## 不做什么

- 不重写 ExoPlayer 的封装（`FoliaNativePlayer` 的播放能力够用，问题在它上面那层「谁决定
  下一首」）。
- 不改桌面端（Electron）的链路：那边主进程本来就是独立进程，问题只在安卓的 WebView 形态。
- 不动已发布的存储键名。
