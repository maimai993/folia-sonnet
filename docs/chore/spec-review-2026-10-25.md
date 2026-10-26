# 规范复核报告（2026-10-25）

触发：同步上游 dev 的工程化改动（门禁脚本 / 契约文档 / CI）后，对全仓做一次规范符合性复核。
三份审查分别由独立子代理完成（前端 / 原生 Kotlin / 工程化），**本报告只记录事实与优先级，不含改动**。

关联提交：`0fea6cf4`（同步工程化）→ `dbc4a4fc`（修编不过 / CI 必红 / 文档过期）

---

## 一、结论速览

| 面 | 门禁绿灯 | 真实达标 | 已修 | 待办 |
|---|---|---|---|---|
| 前端 | 2/7 | 0/7 | — | 7 类存量债（见二） |
| 原生 Kotlin | — | — | 12 处签名冲突 + 1 处 NPE | 桥阻塞 1、线程护栏 6、可见性 69 |
| 工程化 | 4/7 | — | lockfile、版本策略、codemap、门禁单测 | 契约门禁未接线 |

> 「门禁绿灯但真实不达标」的原因：`ci/fileSizeBaseline.json` 与 `ci/uiControlBaseline.json`
> 是按**本地现状**快照的（只许变小的白名单），所以现在跑必然通过。这是基线机制的本意，
> 不代表代码合格。

## 二、前端（src/）

1. **单文件行数**：605 个 tsx 里 11 个超 800。最该先拆：`App.tsx` 3464、
   `grid/collection/GridView.tsx` 2337、`grid/artist/ArtistGridView.tsx` 1564、
   `SettingsModal.tsx` 1479、`entries/wallpaperSurface.tsx` 1300。拆分建议按职责边界见提交记录。
2. **手写控件**：209 文件 / 574 处 `<button|input|select|textarea>`，集中在
   `src/library/suites`（206 处）、`src/components/modal`（94）、`command-palette`（30）。
   必须先落地 `src/components/ui/` 控件库（本仓库尚未同步），否则无从迁移。
3. **store 分层**：`src/stores` 之间 13 条互引（12 条是 12 个 store 引 `useStatusMessageStore`，
   1 条是 layout 两个 store 互引）。建议把 `setStatusMessage` 提成 `src/services/statusMessage`。
4. **目录归属**：6 条 store 反向依赖组件目录（`exploreFeedMemory`、`visualizer/registry` 的
   `tuningDefinition/tuningRegistry`、`PanelTab` 类型等）。纯逻辑与类型应下沉到 `src/utils`/`src/types`。
5. **i18n**：`libraryTui.sourceCloudTheme` 缺 en/in；代码里 37 个 `t()` 键在 zh-CN 未定义，
   其中 21 个属 `remote.*`（整个遥控模块没有译文）。
6. **零引用**：15 个文件有定义无引用，其中 5 个是上游合并被吃入口的残骸
   （`onlineMusic/qishui/*` 整包、`OnlineProviderSwitcher`、`ProviderConnectButton`、
   `useLocalTrackSortStore` + `LocalTrackSortMenu`）。
7. **CSS**：`src/index.css` 47 个类选择器 + 23 处非 `data-folia-*` 属性；`androidPhoneFit.css`
   有 10 个类选择器与 39 处非 `data-folia-*`（含 `[data-testid]`、`[role=tablist]`、直选 Tailwind 原子类）。

## 三、原生 Kotlin（android/）

已修：

- 12 处「属性 + 同名 getter/setter」JVM 声明冲突（kotlinc 必报 `Platform declaration clash`），
  私有一律加下划线前缀。其余 8 处疑似项经核对是误报（`isXxx()` 不撞 `Boolean x`；
  `setChromeHidden(Boolean,Boolean)` / `setNeteaseUid(String?)` 参数签名不同）。
- `materializeAudioCopy` 的 `sourceFile!!`：ref 形态异常时原来直接 NPE，改为显式判空返回 null。

待办（按优先级）：

1. `FoliaNativePlugin.downloadUpdate` 在 `@PluginMethod` 里同步 `execute()` 下载上百 MB，
   占满 Capacitor 唯一的桥线程 → 照同文件 `cacheAudioFromUrl` 改成独立线程。
2. 6 处 `startActivity` 缺主线程护栏（`FoliaWallpaperPlugin.openOverlaySettings/openPicker`、
   `RomPermissionGuide.open`、`FoliaNativePlugin.installUpdate`、`FoliaSpotifyPlugin.signIn`、
   `FoliaCrashHandler.showCrashScreen`）。现代 Android 不会当场崩，但违反「UI 操作必须
   runOnUiThread」；`git show` 核对**迁移前 Java 同样没有**，属既有债而非回归。
3. 69 个成员因 Kotlin 无包私有放宽成 public（`WallpaperOverlay.attach/detach`、
   `LocalAudioServer.clearMediaCache/mediaCacheStats`、`LyricsRenderer.setVideoActive/releaseVideo`、
   `FoliaPlaybackService.activeService`）。建议收回 `internal`。
4. `FoliaApplication.getSystemService` 覆写返回非空 `Any`，super 允许 null → 边界 NPE 风险。
5. 迁移完整性本身没问题：52 个文件的方法名零缺失、注释行无一处下降超过 2.1%、
   无 Java 语法残留（`.length()` 命中全是 `JSONArray`/`File` 的方法）。

## 四、工程化

已修：lockfile 补齐 3 个依赖并同步版本号（否则 `npm ci` 与 `check:versions` 都红）；
`docs/CODEMAP.md` 按本地树重生成；补 4 个门禁单测（23 用例全绿）。

待办：

1. `ci/contracts/extract.ts` **没有 npm script，也没接进 CI** —— 契约门禁目前只能手跑。
   上游同样缺口，建议本仓库补 `check:contracts` 并加进 `ci.yml`。
2. `docs/contracts/sync-server-api.md` 写了 `GET /settings/confirmation`，但本地
   `sync-server/src` 没有该路由（对应实现随另一条 PR 未同步）；manifest 里 4 条
   `admin/api/ai-cache/*` 路由与 6 个 provider 在文档里没有成文。
3. ⚠️ **本地 `dist/` 的生产构建把 `CODEBUDDY_GATEWAY_AUTH` 的值内联进了产物**
   （`node ci/checkSecrets.ts --dist dist` 命中 21 行）。CI 干净环境不会命中，但**这份
   dist 不能对外分发**，重新构建前先清掉该环境变量。

## 五、建议执行顺序

1. （已完成）修编译级问题：Kotlin 签名冲突、lockfile、版本策略。
2. 修 `downloadUpdate` 桥阻塞 + 6 处 `startActivity` 线程护栏（原生侧，改动小、收益直接）。
3. 补 `remote.*` 21 个 i18n 键 + 删 5 处上游残骸（低风险、纯数据/纯删除）。
4. 拆 `App.tsx` → `GridView` → `ArtistGridView`，每拆一份把 `fileSizeBaseline.json`
   对应项调低，让门禁真正收紧。
5. 同步 `src/components/ui/` 控件库后再批量替换手写控件（工程量最大，独立批次）。
