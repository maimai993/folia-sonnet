# 安卓桥契约（`FoliaNative`）

页面（WebView 里的 React）与安卓原生之间的方法调用。原生侧全部方法挂在
`FoliaNative` 这一个 Capacitor 插件下，权威定义是
`android/app/src/main/java/top/izuna/foliamajor/FoliaNativePlugin.kt` 里每个
`@PluginMethod fun <名字>(call: PluginCall)`；页面侧的调用点在各 `src/services/*.ts`。

**这条边界之前没有契约文档**（issue M35）：方法名或参数改了，页面侧不会报错，
只会静默回落到「没有原生加速」的老路径 —— 表现是「功能看着还在，但其实没走原生」。
这份文档和 `test/unit/contracts/androidBridgeDrift.test.ts` 一起，把三个东西钉住：
原生有哪些方法、页面调了哪些、页面侧的类型声明在哪一处。

## 与其他契约的关系

| 边界 | 文档 |
| --- | --- |
| 页面 ↔ 主进程（Electron） | [electron-ipc.md](electron-ipc.md) |
| 页面 ↔ 同步服务（HTTP） | [sync-server-api.md](sync-server-api.md) |
| 页面 ↔ 各音乐平台 | [online-music-omni.md](online-music-omni.md) |
| 凭据存在哪 | [secrets.md](secrets.md) |
| **页面 ↔ 安卓原生** | 本文 |

## 调用方怎么拿插件

页面侧**不许**各写一份「桥在不在」的判断。统一走
`src/services/nativePluginAccess.ts`：

```ts
export const getNativePlugin = <T>(pluginName: string, isOnNativePlatform: () => boolean): T | null;
```

判据由调用方传，因为各模块要的语义本来就不同：

| 传进来的判据 | 用在谁身上 | 为什么 |
| --- | --- | --- |
| `() => isCapacitorAndroidPlatform()` | `nativeHttpFetch`、`aiNativeFetch`、`aiNativeCompletion` | 这些一定在桥起来之后才被调用，用最严格的 Capacitor 判据 |
| `isAndroidAppShell`（`platform/runtime`） | `nativeSettingsBridge` | 冷启动头几秒就要读设置，那时桥还没起来；「桥没起来」不能当成「平台不支持」 |

两条硬约束：

- **判「插件在不在」不能写成 `typeof plugin?.someMethod === 'function'`。** `registerPlugin()`
  返回的是代理，任何方法名问过去都是 function，原生一行没写也返回 true（真出过一次：
  凭空点亮平台入口、报「未登录却有账号」）。要查注册就查 `Capacitor.isPluginAvailable()`，
  它读的是原生上报的 pluginHeaders。
- **页面侧同一个方法的入参/出参类型只许声明一处。** 现在它们在各自的
  `src/services/*.ts` 顶部以 `type Native*Plugin = { ... }` 的形式声明，一个模块一段；
  新增桥方法时加在**已有的那一段**里，不要另起一处。

## 可选即回落

**所有桥方法在类型里都是可选的**（`method?: (...)`）。老版本 App 没有新方法时，
页面侧必须回落到非原生的老路径，而不是抛错：

```ts
const plugin = getNativePlugin<NativePlugin>('FoliaNative', () => isCapacitorAndroidPlatform());
if (!plugin?.someNewMethod) return null;   // 老版本 App：调用方按「这条路不可用」处理
```

这是这条边界上最重要的一条兼容规则：**App 与网页是分开升级的**，用户可能装着上个版本的
App 打开新页面。新增方法一律「加」，不改签名、不删方法；确实要废弃时先让页面侧停止调用，
隔一个版本再从原生删掉。

## 方法清单

按用途分组。`出参` 只写页面侧真正依赖的字段；原生回了但页面不看的字段不列。
「没有单测」= 只有真机能验，见每节末尾。

### AI

| 方法 | 入参 | 出参 / 失败形态 |
| --- | --- | --- |
| `setAiConfig` | `{ config: { provider, geminiApiKey, geminiApiUrl, apiKey, model, baseUrl, temperature } }` | 无返回内容。写入原生设置仓库；凭据只存原生，见 [secrets.md](secrets.md) |
| `runAiCompletion` | `{ system, prompt, maxTokens, json }` | `{ text: string }`；失败 reject，message 以错误码开头：`ai-not-configured`、`ai-http-error:<状态码>`、`ai-empty-response`、`ai-request-failed`、`ai-refused`。**所有失败路径都过 `AiEndpoints.redact`**（issue M29） |
| `aiRequest` | `{ url, method, headers, body }` | `{ ok: boolean, status: number, body: string }`。整趟由 OkHttp 走完，不依赖 JS 在跑 |
| `aiCloudCacheGet` | `{ key, url }` | `{ ok: boolean, body: string, cached?: boolean }`；拿不到返回 null |

页面侧：`aiNativeCompletion.ts`（`setAiConfig` / `runAiCompletion`）、`aiNativeFetch.ts`
（`aiRequest` / `aiCloudCacheGet`）。

`runAiCompletion` 的错误码是**契约的一部分**：页面侧的 `translateAiCompletionError`
按这些前缀翻译文案。加新错误码要同时改那边。

### 同步与设置

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `getSettings` | 无 | 整份设置快照（键名与原生的设置默认值表一一对应） |
| `setSettings` | `{ values }` | 合并后的整份快照 |

页面侧：`nativeSettingsBridge.ts`。**设置的真身在原生**：它决定循环模式、跳过不可播、
方向设置等原生播放逻辑的行为，所以页面不做本地缓存、不做乐观更新。

### 凭据

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `readSecureValue` | `{ key }` | `{ value: string 或 null }` |
| `writeSecureValue` | `{ key, value }` | 无返回内容 |
| `clearSecureValue` | `{ key }` | 无返回内容 |
| `hasSecureValue` | `{ key }` | `{ has: boolean }` |

存进 Android Keystore 的 AES-GCM 槽位。哪些值算凭据见 [secrets.md](secrets.md)。

### Cookie 与 HTTP 出口

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `cookiesGetAll` | `{ url }` | cookie 列表 |
| `cookiesGet` | `{ url }` | 单条 cookie |
| `cookiesSet` | `{ url, cookie }` | 无返回内容 |
| `cookiesRemove` | `{ url }` | 无返回内容 |
| `cookiesRemoveBatch` | `{ urls }` | 无返回内容 |
| `httpRequest` | `{ url, method, headers, body }` | `{ ok, status, headers, body }` |

`httpRequest` 是**通用出口**，主机白名单与来源校验原生侧自己管（issue C1）；
页面侧不许把它当成「想连哪就连接哪」的通道。

### 后台主题

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `getBackgroundThemeResult` | `{ songKey, policy, lyricText }` | `{ payload, source: 'ai' 或 'cloud' }`；未命中返回 null |

页面侧：`backgroundThemeBridge.ts`。`source` 只认 `'ai'` 与 `'cloud'` 两个值，
其他值按「未命中」处理。

### 播放与媒体

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `registerRemoteAudio` | `{ url, ... }` | 注册结果 |
| `registerScopedRemoteAudio` | 同上，作用域受限 | 注册结果 |
| `unregisterRemoteAudio` | `{ id }` | 无返回内容 |
| `cacheAudioFromUrl` | `{ url }` | 缓存结果 |
| `mediaCacheStats` | 无 | 缓存占用统计 |
| `clearMediaCache` | 无 | 无返回内容 |
| `copyLocalAudio` | `{ source, target }` | 结果 |
| `deleteImportedAudio` | `{ uri }` | 无返回内容 |
| `setAudioFocusPolicy` | `{ policy }` | 无返回内容 |
| `setPlayerVisible` | `{ visible }` | 无返回内容 |
| `setScreenAwake` | `{ awake }` | 无返回内容 |

### 本地音频与文件

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `scanLocalAudio` | 扫描参数 | 音频条目列表 |
| `pickAudioFiles` | 选择参数 | 选中的文件 |
| `pickAudioFolder` | 选择参数 | 选中的目录 |
| `takeExternalAudioUris` | 无 | 外部传入的 uri 列表 |
| `localAudioServerPort` | 无 | 本地服务的端口号 |
| `requestAllFilesAccess` | 无 | 授权结果 |
| `saveFile` | `{ name, data }` | 保存结果 |
| `saveFileFromPath` | `{ name, path }` | 保存结果 |

### 投送

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `lanCastPrepare` | 投送参数 | 租约与地址 |
| `lanCastRelease` | 不用参数 | 无返回内容 |
| `registerSelfHostedService` | 服务描述 | 注册结果 |
| `setGatewayCredentials` | 凭据 | 无返回内容 |

### 界面

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `setImmersive` | `{ enabled }` | 无返回内容 |
| `setSystemBarsPolicy` | `{ policy }` | 无返回内容 |
| `getPhoneInsets` | 无 | 安全区尺寸 |
| `getPhoneFitLayout` | 无 | 当前适配布局 |
| `setPhoneFitLayout` | `{ layout }` | 无返回内容 |
| `getDisplayCutout` | 无 | 刘海区域尺寸 |
| `setDisplayBoost` | `{ enabled }` | 无返回内容 |
| `showToast` | `{ message, durationMs }` | `{ shown: boolean }` |
| `showOverlayNotice` | `{ message, durationMs }` | `{ shown: boolean }`（只许别的应用在前台时用） |
| `exitApp` | 无 | 无返回内容 |
| `moveToBackground` | 无 | 无返回内容 |
| `openUrl` | `{ url }` | 无返回内容 |

### 更新与视频层

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `downloadUpdate` | 更新包地址 | 下载结果 |
| `installUpdate` | 安装参数 | 安装结果 |
| `pickVideoLayerFile` | 选择参数 | 选中的文件 |
| `downloadVideoLayerFile` | 地址 | 下载结果 |
| `getVideoLayerFile` | 无 | 当前视频层文件 |
| `clearVideoLayerFile` | 无 | 无返回内容 |

## 怎么改

改一个桥方法 = **改原生 + 改页面侧类型与调用点 + 改本文 + 跑漂移测试**。

1. 原生加 `@PluginMethod fun`。
2. 页面侧类型里**加可选方法**（不改已有签名），调用点按「没有就回落」写。
3. 本文对应分组加一行。
4. `npx vitest run test/unit/contracts/androidBridgeDrift.test.ts --maxWorkers=1`。

漂移测试查三件事：

- 原生 `FoliaNativePlugin.kt` 里每个 `@PluginMethod` 方法名都在本文出现过；
- 本文表格里出现的每个方法名，原生侧确实还有（防止文档记录已删的方法）；
- 页面侧类型声明里出现的桥方法名，原生侧确实有（防止页面调用一个不存在的方法）。

## 已知缺口

- **没有跨语言运行时测试。** 漂移测试比对的是「原生 Kotlin 文件里的方法名」与
  「本文表格里的方法名」这份文本，不是真的拉起安卓运行时。入参字段名拼错这类错误它抓不到，
  只能靠真机。
- **出参形状没有机器校验。** 原生 `JSObject` 放进去什么、页面 `as` 成什么类型，
  中间没有 schema。改动出参时要人工核对两侧。
