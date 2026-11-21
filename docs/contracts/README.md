# 前后端契约文档

跨边界的东西先在这里写清楚：谁调用谁、传什么、回什么、错成什么样、哪些值不许越界。
读代码能看出实现，读这组文档能看出**对面依赖了什么**。

## 这组文档是什么

- 记录三条边界加一套凭据规则，不记录部署步骤、不记录平台细节：

| 文档 | 边界 | 权威文件 |
| --- | --- | --- |
| [sync-server-api.md](sync-server-api.md) | 客户端 ↔ 自建同步服务（HTTP） | `sync-server/src/app.ts` 及同目录子路由模块 |
| [electron-ipc.md](electron-ipc.md) | 渲染进程 ↔ 主进程（Electron IPC） | `electron/preload.cjs` + `src/vite-env.d.ts` 的 `Window['electron']` |
| [online-music-omni.md](online-music-omni.md) | 界面/状态 ↔ 在线音乐各平台 | `src/services/onlineMusic/omni.ts`、`src/types/onlineMusic.ts`、`src/services/onlineMusic/providerRegistry.ts` |
| [android-bridge.md](android-bridge.md) | 页面 ↔ 安卓原生（`FoliaNative` 插件） | `android/app/src/main/java/top/izuna/foliamajor/FoliaNativePlugin.kt` 的 `@PluginMethod`，页面侧类型在各 `src/services/*.ts` |
| [secrets.md](secrets.md) | 凭据 ↔ 存放位置、流程、日志 | 各实现文件，逐条注在正文里 |

- 每一条契约后面注 `文件:行`。行号会随代码漂移：**定位以符号名为准**，行号只帮忙找到起点。
- 已有的专门文档不抄第二份，只链接：
  - 同步服务部署与运维：`sync-server/README.md`
  - 在线音乐分层、接入新平台：`src/services/onlineMusic/README.md`
  - 各平台依赖的上游库与版本：`src/services/onlineMusic/UPSTREAMS.md`
  - 探索页适配：`src/services/onlineMusic/EXPLORE_ADAPTER.md`
  - 日志写法与取舍：`docs/client-logging.md`
  - 桌面构建的手工验证：`skills/run-desktop/SKILL.md`

## 谁是契约

**代码是契约，测试是它的探针，文档只是摘录。** 文档和代码冲突时以代码为准，并在同一个 PR 里把文档修好（见下一节）。

| 边界 | 权威文件 | 校验它的东西 |
| --- | --- | --- |
| HTTP | `sync-server/src/app.ts`（`app.route()` 挂的子模块同样算权威：`fonts.ts`、`aiCache.ts`、`stageGallery.ts`、`admin.ts`、`adminCachePages.ts`、`statsImage.ts`） | 客户端侧解析 `src/services/sync/syncSchema.ts`（拒绝不合规的响应）、`test/unit/sync-server/*`、`test/unit/sync/*` |
| IPC | `electron/preload.cjs`（暴露面）+ `src/vite-env.d.ts`（类型与可选性）+ 各 `electron/**` 的 `ipcMain.handle` | `test/unit/electron/ipcSecurity.test.ts`（外部链接白名单、发送方守卫） |
| omni | `src/types/onlineMusic.ts`（形状与语义）+ `omni.ts`（编排）+ `providerRegistry.ts`（平台清单） | `test/unit/onlineMusic/omniArchitecture.test.ts`、`test/unit/onlineMusic/platformNamePlaces.ts` |
| 凭据 | 见 [secrets.md](secrets.md) 的「代码依据」表 | 各模块注释、`test/unit/` 下的凭据与日志用例 |

几条一直成立的硬约束：

- 依赖方向：`components`、`hooks`、`stores` 不直接 import 平台的 `*Provider.ts` / `*Transport.ts`（`test/unit/onlineMusic/omniArchitecture.test.ts:10,21-29`；规则原文在 `AGENTS.md` 的「模块边界」）。
- 渲染进程只经 `electron/preload.cjs` 找主进程，窗口一律 `contextIsolation: true`、`nodeIntegration: false`（`electron/main.cjs:5514-5520`、`5337-5343`）。
- 在线歌曲的搜索、播放、歌词、歌单、账户都走 `omni`（`AGENTS.md` 的「在线歌曲只走 omni」）。

## 怎么改契约

改契约 = **改实现 + 改文档 + 改登记表（manifest）/测试**，三件事在同一个 PR 里。

1. 先改实现（服务端路由 / preload + 主进程 / provider / 凭据存放处）。
2. 改本目录对应文档的条目：路径、字段、可空性、错误码、限制、`文件:行`。
3. 改钉住它的东西，否则下一个人会以为文档过时：
   - HTTP：`sync-server/README.md` 的 API 表与协议约束段、客户端解析器 `src/services/sync/syncSchema.ts`（新字段要让旧服务端仍能读）、`test/unit/sync-server/` 与 `test/unit/sync/` 的用例。
   - IPC：`electron/preload.cjs`、`src/vite-env.d.ts` 的类型、`electron/main.cjs` 的 handler 与发送方校验、`test/unit/electron/ipcSecurity.test.ts`；网页版没有 `window.electron`，类型必须保持可选，调用方继续用可选链。
   - omni：`src/types/onlineMusic.ts` 的契约注释、`omni.ts` 的 `can*` 开关、各平台实现、`platformNamePlaces.ts`（平台目录之外提到平台名的行数要登记并说明原因）。
   - 凭据：改存放位置时同步 [secrets.md](secrets.md)，并检查日志、导出、同步三条出口。
4. 保持兼容的方向：
   - 服务端不破坏旧客户端：`PUT /settings` 同时接受 `schemaVersion` 1 与 2（`sync-server/src/app.ts:535-536`），客户端解析器也接受 1 与 2（`src/services/sync/syncSchema.ts:27-28`）。
   - IPC 只加不改：增函数、增事件即可；删/改签名要同时改 preload、`vite-env.d.ts` 和每个调用点。
   - omni 的新能力：先加 `ProviderCapabilities` 与类型，再加 `omni` 方法，再让各平台实现；缺实现时回空值或抛 `OnlineProviderError('unsupported')`，不用旁路。
5. 提交前跑和本目录相关的门禁：`npx tsc --noEmit`、`npm run check:ui`、`npm run check:size`，以及 `npx vitest run -c vitest.config.ts test/unit/sync-server test/unit/onlineMusic test/unit/electron`（改到哪块跑哪块，能跑全量更好）。

## 索引

- [sync-server-api.md](sync-server-api.md)：41 条 HTTP 路由的方法、路径、鉴权、请求/响应、错误码、可空性，以及必须挂在兜底网之前的原因。
- [electron-ipc.md](electron-ipc.md)：`window.electron` 的命名空间、invoke 与 send 的区别、事件订阅、错误形态、发送方信任边界。
- [online-music-omni.md](online-music-omni.md)：omni 对调用方保证什么、各平台必须实现什么、能力开关、错误模型、注册表契约。
- [android-bridge.md](android-bridge.md)：`FoliaNative` 的 58 个方法按用途登记、可选即回落的兼容规则、桥的「在不在」为什么只能在一处判、方法名漂移测试覆盖什么。
- [secrets.md](secrets.md)：哪些值是凭据、允许出现在哪里（主进程 / 钥匙串 / 安卓原生 / 渲染进程内存）、绝对禁止的三条出口。

## 约定

- 响应形状写成 TS 片段；可空字段标 `| null`，缺省字段标 `?`。
- 错误码写服务端/实现里**实际的字符串**，不改写成 HTTP 语义。
- 中文说明，标识符、路径、错误码、日志前缀保持原文。
