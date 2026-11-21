# RhinE 主题在 Folia 里的分层（终态约定）

> 改编自 RhinE（<https://github.com/ericzhang12111-cell/RhinE>，v2.1.1，MIT）。本文件由 Folia 编写。

这是「莱茵生命主题接入」几轮之间的**唯一口径**：哪些东西进仓库、放在哪、由谁维护。前一轮的结论写在这里，后一轮照它做，不在 PR 里重新争一遍。

相关 issue：#421（接入，第一轮已落地）、#440（资源包下载）。

## 分层

```
第 1 层  主题代码骨架        res/rhine-theme/          上游原样搬入，只读留档
第 2 层  宿主适配            res/rhine-theme/adapt/    本仓库维护；宿主 → 主题的全部接口都在这
第 3 层  宿主自己的界面      src/library/suites/rhine/  React 组件，用 Folia 的控件与 i18n
第 4 层  资源包（可选下载）  运行时缓存，不进仓库         见 #440
```

### 第 1 层：主题代码骨架（上游原样）

- `res/rhine-theme/js/`、`columns/`、`tokens/`、`online/`：RhinE 2.1.1 的代码，**逐字没改**，出处与清单见 `res/rhine-theme/RHINE-SOURCE.md`。
- 放 `res/` 不放 `public/`：这一层现在不参与构建、不进安装包（150 MB 的 APK 里不该有一份还跑不起来的 JS）。等视图真的接到第 3 层上，再决定要不要、以及怎么让构建带上它。
- 上游升级：把新的 `theme/` 拷进来覆盖，`adapt/` 与第 3 层不动，看 diff 就知道上游改了什么。

### 第 2 层：宿主适配（`res/rhine-theme/adapt/` + `host-entry.js` + `index.html`）

- 宿主（React 那一侧）告诉主题的一切，只走 `window.FOLIA_RHINE` 与 `postMessage`；格式在 `RHINE-ASSETS.md` 的「接口」一节。
- **要改上游行为时，写一个新的 `adapt/` 文件，不改上游文件**。例如以后要把 `fb` 的播放控制翻成宿主回调，就在 `adapt/` 里加一个 `rhinePlaybackBridge.js`，让上游反过来调它。
- 第 2 层的代码属于 Folia，跟着 Folia 的规范走（4 空格缩进、单引号在这里不适用 —— 它是普通脚本，跟随上游风格；但注释、日志、文案仍然按 Folia 的规矩）。

### 第 3 层：宿主自己的界面

- `src/library/suites/rhine/RhineHome.tsx` 是唯一入口：它渲染 iframe，把语言 / 明暗 / 是交互状态 / 资源包状态推给第 2 层，并接收主题发回来的动作（播放、入队、打开设置、搜索）。
- 主题里的「设置 / 搜索」这类入口一律指回 Folia 自己的实现，不在 iframe 里复刻一套。
- **不把上游的界面构建产物整块嵌进来**。老主题（`src/library/suites/rhine` 改造前的版本）就是这么做的：`public/rhinelab/` 里放的是 RhineLabUI 的打包结果（`assets/index-*.js`，1 MB 的压缩 bundle），我们只能靠 `folia-rhine-patch.js` 在 bundle 里插探针来改它的行为，上游一改构建就全废。这一轮把那条路整个撤掉了。

### 第 4 层：资源包

- 见 `RHINE-ASSETS.md`：默认不下载，缺资源一律降级成纯色 / 占位，页面壳永远不依赖它。

## 不进仓库的东西

| 东西 | 为什么不进 |
| --- | --- |
| `theme/assets/`（913 MB） | 体积；做成可选下载（#440） |
| `install.ps1` / `install.cmd` / `uninstall.*` | foobar2000 的安装程序，Folia 里没有对手 |
| `theme/update/` | 上游的自更新清单，Folia 有自己的一条更新链路 |
| `theme/screenshots/` | 预览图 |
| 老主题的 `public/rhinelab/` | 已删除，见下一节 |

## 旧主题（RhineLabUI 静态页）的处理

这一轮把 `public/rhinelab/`（10.72 MB / 71 个文件，是 RhineLabUI 的构建产物 + 我们的补丁脚本）**整个移出仓库**，入口从它换成 `res/rhine-theme/index.html`：

- 为什么不是保留成「可选的旧主题」：那 1 MB 的 bundle 是压缩过的第三方产物，我们唯一能改它的手段是 `tools/patch-rhine-bundle.mjs` 往里面插函数（靠锚点字符串匹配），上游换个构建就断。留着它，就等于保留一条随时会坏的路径，还得为它维护四个 `test/manual/rhine*.mjs` 探针。
- 撤掉的东西：`public/rhinelab/`、`tools/patch-rhine-bundle.mjs`、`test/manual/rhineBootProbe.mjs`、`test/manual/rhineOverlayCheck.mjs`、`test/manual/rhinePatchCheck.mjs`、`test/manual/rhinePatchSyntax.cjs`、`test/manual/rhineResumeCheck.mjs`、`test/manual/rhineSelectingCheck.mjs`、`test/manual/rhineSelectingDebug.mjs`。
- 跟着旧 bundle 走的三条消息（`rhine-policy` 帧率上限、`rhine-overlay` 卡片可视化、`rhine-insets` 安全区）这一轮不再发送：新骨架里没有对应的实现，发了也没人接。它们的退路 `useRhineOverlayStore`（`rhine_card_visualizer` 开关）保留不动，`src/stores/` 的存储键也没有改名。
- 旧的 `RhineVisualOverlay.tsx`、`rhinePayload.ts`、`rhineLibrary.ts`、`rhineShelf.ts`、`useRhineGestures.ts`、`useRhineLandscape.ts` 原本是给那套 bundle 算卡片矩形、推曲库用的，一并删除；曲库那一层等视图接进第 3 层时重写（到时是 React 自己画，不再需要往 iframe 里推一套档案格式）。
