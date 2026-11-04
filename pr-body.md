## 做了什么

把旧的毛玻璃开关换成上游 Riru233/folia-major 的液态玻璃，并把玻璃效果铺开到全站。

### 设置项

设置 → 性能与动效 → 液态玻璃（新组）：

- 总开关
- 四档预设：毛玻璃 / 通透流体 / 朦胧流体 / 节能（用上游原版 2x2 预览图网格 `GlassPresetGrid`，效果图在 `public/glass-presets/`）
- 四条参数：强度、弯曲距离、模糊、饱和度
- 两个效果开关：光效、果冻

旧的毛玻璃开关（`GlassSurfaceSetting`、`useGlass`、`folia_glass_surfaces_disabled`）连同 CSS 与 i18n 一起删除。

### 修掉的两个既有缺陷

1. **安卓上玻璃完全不生效。** 判定写的是 `runsOnWindows() || (isMacPlatform && isChromiumRenderer())`，安卓 WebView 的 UA 里没有 `win` 也不是 Mac，于是被判成画不了位移图：折射滤镜不建、通透/朦胧两个预设被过滤掉、强度与饱和度两行不显示——玻璃只剩一层模糊，看起来就是旧的毛玻璃。改成按**内核**判定（Chromium/Edge/OPR/Samsung，排除 Firefox/FxiOS）。
2. **`sat` 兜底值 1。** `clampLiquidGlassParam` 在不支持位移图时把饱和度钉回 `1`，那是 1%，画面会被抽成近乎灰白。改成中性值 `100`。

### 玻璃面铺开

- 注入选择器覆盖首页胶囊、拍立得卡、播放页右下角卡片、各 suite 下拉与面板
- 玻璃开启时统一把实底背景压透到 72%（`html[data-liquid-glass='on']` 作用域）：不压透，折射滤镜背后没画面，看不出效果。全屏遮罩与播放页侧面板豁免
- `settingsTokens` / `panelTokens` / `ponderWindowTokens` 加 `glass` 参数：设置、登录、播放面板、Ponder、主题乐园、听觉档案的表面在玻璃开启时转半透明

### Segmented 滑动选择 + 果冻

`kit/Segmented.tsx` 全站共用，改这一处全部生效：按住横向滑动可切换选项（6px 容差、竖向先走则让位给滚动），胶囊按拖动方向拉伸并弹簧回弹。

## 验证

| 项 | 结果 |
|---|---|
| `npm run ci:local`（ui/size/versions/密钥/typecheck/build） | 通过 |
| 单测 | 13065 项中 1 项失败 |
| 真机 | 见下 |

单测那一项是 `spotifyAudio.test.ts`，在全量并发下 `Spotify audio went quiet` 超时；单跑 21 项全过，与本次改动无关（`test/unit/electron/videoExportFileWriter.test.ts` 之前也是同类并发问题）。`ci/typecheckSyncServer.ts` 在 Windows 上因 `spawnSync(npm.cmd, …, stdio:'inherit')` 失败，在**未改动的干净代码上同样失败**，`sync-server` 的 `build:node` 单跑通过——是既有的本地环境限制，以 Linux CI 为准。

## 真机验证

机型 / 系统：____（待填）
APK：`Folia-0.7.25.dev5-liquidglass.apk`（versionCode 7025105，已签名）

验了这些路径：

1. 设置 → 性能与动效：液态玻璃组是否出现，四个预设是否都在（不再只有两个）
2. 各界面（播放页右下角、首页拍立得卡、页签胶囊、设置、登录页、歌单二级列表、歌词动画选择窗）透明与折射是否有出来
3. 预设那一排按住左右滑动——是否能滑着换预设，胶囊是否拉伸回弹
4. 网格点歌单——是否不再透出后面的播放层

**请人工确认布局是否符合预期。** 尤其是第 2 项：72% 这个压透档位是我定的，不是上游原值；太透或太实都只需改一个数（`index.css` 与 `kitTheme.ts` 里的 72）。
