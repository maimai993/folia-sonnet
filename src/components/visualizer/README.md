# Visualizer 代码地图

Visualizer 是一个由共享 shell/runtime/registry 组合多个歌词渲染模式的目录。新增或修复模式时，先从统一入口定位，不要从 `App.tsx` 复制渲染分支。

## Runtime flow

```text
App / ThemePark / VisPlayground / OBS source
  -> VisualizerRenderer.tsx
       -> applyVisualizerTuning()
       -> backgrounds/registry.tsx（默认背景与背景 entry）
       -> registry.tsx（按 VisualizerMode 找到 <mode>/entry.tsx）
       -> mode renderer
       -> VisualizerHarmonyOverlay
```

共享外壳在 `VisualizerShell.tsx`：透明容器、背景 renderer、字体栈/字重、返回按钮和 player-panel hotspot。底部/翻译字幕通常由 `VisualizerSubtitleOverlay.tsx` 或模式自身按既有契约处理。共享契约在 `definition.ts`，不要在模式组件里重新声明一套歌词 props。

运行时辅助在 `runtime.ts`：

- `useVisualizerRuntime`
- `getRecentCompletedLine`
- `getUpcomingLine` / `getUpcomingLines`
- `shouldPreheatLine`
- `prepareActiveAndUpcoming`

这些函数统一当前行、上一句、下一句和预热窗口；不要在新模式中重新扫描 `lines`。

## Current mode registry

每个模式通过 `src/components/visualizer/<mode>/entry.tsx` 注册，registry 使用 Vite `import.meta.glob('./*/entry.tsx', { eager: true })` 自动发现。当前模式：

| mode | 显示名 | 主要 renderer / 辅助文件 |
| --- | --- | --- |
| `classic` | Luminous | `classic/Visualizer.tsx`、`classic/tuning.ts` |
| `cadenza` | Mindscape | `cadenza/VisualizerCadenza.tsx`、`cadenza/tuning.ts` |
| `partita` | 云阶 | `partita/VisualizerPartita.tsx`、`partita/tuning.ts` |
| `fume` | Fume | `fume/VisualizerFume.tsx`、`fume/tuning.ts` |
| `cappella` | Cappella | `cappella/VisualizerCappella.tsx`、`avatarImages.ts`、`emoImages.ts` |
| `tilt` | Tilt | `tilt/VisualizerTilt.tsx`、`tilt/tuning.ts` |
| `claddagh` | Claddagh | `claddagh/VisualizerCladdagh.tsx`、`claddagh/tuning.ts` |
| `monet` | Monet | `monet/VisualizerMonet.tsx`、`monet/monetLyricsModel.ts`、`monet/tuning.ts` |
| `diorama` | 镜台 | `diorama/VisualizerDiorama.tsx`、`diorama/DioramaScene.tsx`、`diorama/dioramaTextRaster.ts` |
| `pendolo` | Pendolo | `pendolo/VisualizerPendolo.tsx`、`pendolo/pendoloTextLayout.ts`、`pendolo/pendoloTimeline.ts` |
| `sonnet` | 商籁 | `sonnet/VisualizerSonnet.tsx`、`sonnet/createSonnetPixiRuntime.ts`、`sonnet/*` |
| `tempera` | 蛋彩 | `tempera/VisualizerTempera.tsx`、`tempera/createTemperaPixiRuntime.ts`、`tempera/*` |

`registry.tsx` 的默认模式是 `classic`。模式枚举/共享 tuning map 见 `src/types.ts`、`definition.ts`、`tuningRegistry.ts`。

## Background registry

背景 entry 位于 `backgrounds/<name>/entry.tsx`，由 `backgrounds/registry.tsx` 发现；当前实现为：

- `common`：`FluidBackground.tsx`、`GeometricBackground.tsx`，带 `CommonBackgroundSettingsCard.tsx`
- `latent`：`LatentBackground.tsx`、设置卡
- `monet`：`MonetBackgroundLayer.tsx`、设置卡
- `nomand`：`NomandBackgroundLayer.tsx`、设置卡
- `sora`：`SoraBackground.tsx`
- `url`：`UrlBackgroundLayer.tsx`、设置卡

共享背景 props 与默认值在 `backgrounds/definition.ts`；实际渲染在 `backgrounds/VisualizerBackgroundRenderer.tsx`。新增背景不要在每个 visualizer 中内联。

## Shared contracts and helpers

### `definition.ts`

`VisualizerSharedProps` 是模式共同输入，包含 `MotionValue currentTime`、当前行/全部歌词、主题与字幕主题、音频分析值、背景/透明度、字幕显示开关、播放状态、seek/back/panel callbacks、资源和模式 tuning。完整字段以代码为准；本 README 只保留定位信息。

当前 tuning 覆盖 11 个模式，并通过 `VisualizerRenderer` 的 `applyVisualizerTuning` 统一注入。模式级设置面板和 reset 由各自 `entry.tsx` / `tuning.ts` 提供，再由 `settingsPanels.tsx` 和 `VisPlaygroundSettingsPanel.tsx` 复用。

### Lyrics pipeline

Visualizer 消费已解析的 `LyricData` / `Line` / `Word`，不负责解析 `.lrc`、`.vtt`、`.yrc` 或 `.qrc`。

- `src/utils/lyrics/parserCore.ts`：解析真源
- `src/utils/lyrics/renderHints.ts`：`getLineRenderHints`、`getLineRenderEndTime`、短句/快速 reveal
- `src/utils/lyrics/cjkSemanticLayout.ts`：CJK semantic grouping、sticky punctuation、display units
- `src/utils/lyrics/graphemeTiming.ts`：逐 grapheme timing
- `wordColoring.ts`：共享词高亮范围
- `src/utils/fontStacks.ts`：DOM、Canvas、pretext 和光栅化路径统一字重/字体栈
- `colorMix.ts`：主题色 alpha 与混合

`Line.fullText` 用于整句布局，`Line.words` 是 timing 真源；两者不保证简单拼接完全相等。重复词、空格、CJK 和标点不要用字符串搜索重新猜时间范围。

## Mode-specific navigation

### Cadenza / Fume

两者都属于测量和布局敏感模式：实现见 `cadenza/VisualizerCadenza.tsx` 与 `fume/VisualizerFume.tsx`。代码使用 `@chenglou/pretext` 做文字准备/测量；Fume 还维护 article-level layout 与 cache。先查 `src/utils/lyrics/renderHints.ts` 和 `fontStacks.ts`，再改布局。

### Partita

完整的数据流说明见 [`partita/README.md`](partita/README.md)。快速定位：

- `VisualizerPartita.tsx`：sequential layout、缓存、预热、chunk/word 渲染
- `src/utils/lyrics/cjkSemanticLayout.ts`：`buildPostLyricLayoutUnits`、`buildDisplayWordsFromLayoutUnits`
- `src/utils/lyrics/renderHints.ts`：行 transition / word reveal profile
- `PartitaChunk` / `PartitaWord`：行级与 display word 级动画

不要修改 `Line.words`；layout unit 和 display word 只应是 renderer 派生数据。

### Cappella

`cappella/VisualizerCappella.tsx` 负责群唱头像、聊天表情和歌词呈现。内置资源通过 `avatarImages.ts` / `emoImages.ts` 的 glob 载入；用户资源分别由 `src/services/cappellaAvatarPack.ts` 与 `cappellaEmojiPack.ts` 存入 IndexedDB。资源目录说明见 `cappella/avatar/README.md`、`cappella/emo/README.md`。

### Claddagh

`claddagh/VisualizerCladdagh.tsx` 使用 `buildLineGraphemeTimeline`、`pretext` 和有限 ring lines；音频响应/RAF 与 DOM 样式更新必须有界并在 cleanup 中释放。

### Monet

`monet/VisualizerMonet.tsx` 组合 `MonetLyricsRail`、`AudioOverlay`、浮动装饰和背景 pipeline；图像资源还涉及 `src/services/monetBackgroundImage.ts`、`monetPortraitImage.ts`。

### Diorama

`diorama/VisualizerDiorama.tsx` 进入 React Three Fiber 场景；场景/粒子/相机/文字光栅化分别看 `DioramaScene.tsx`、`dioramaParticle*.ts`、`cameraPath.ts`、`dioramaTextRaster.ts`。连续场景数据不要提升到 React state。

### Pendolo

`pendolo/VisualizerPendolo.tsx` 是 React 外壳；`PendoloClockworkCanvas.tsx` 负责时钟机械 canvas，`pendoloTextLayout.ts`、`pendoloTimeline.ts`、`pendoloGeometry.ts` 负责有界布局与时间线，`PendoloSettingsPanel.tsx` 负责调参。

### Sonnet

`sonnet/VisualizerSonnet.tsx` 负责 React shell/subtitle，`createSonnetPixiRuntime.ts` 创建 Pixi runtime；其余 `sonnet*` 文件按 scene builder、shot flow、glyph/typography、post-process、resource pool 分工。注意 Pixi runtime、纹理和 RAF 的销毁。

### Tempera

`tempera/VisualizerTempera.tsx` 负责 React shell/subtitle，`createTemperaPixiRuntime.ts` 创建 Pixi runtime（scene cache ±1、绝对时间驱动、无外部纹理）。与 sonnet 同族但视觉路线不同：`temperaProgram.ts` 编译段落/shot（`duo-split`/`band-strip`/`frame-window`/`poster-panel`/`quiet-line`）；**一个 shot 只放半句**——每行按词边界切成 2~4 词或 ~2.2s 的 `TemperaShotSlice`，所以一句歌词会横跨多个 shot，shot 之间由 runtime 直接交接（上一个 shot 沿 flowAngle 继续推出画面、下一个从上游推进来，两者在 handoff 窗口内同屏重叠），不再有 shot 级的场景转场；flowAngle 以垂直为主轴，交接因此读作纵向长镜头而非切换，`temperaLayout.ts` + `temperaMeasure.ts` 做拼贴式排版：Intl.Segmenter 分词**只用来定字号层级**，不影响字间距——词间只有在原文确实有空白（比对 `startOffset`/`endOffset`）时才给一个空格宽，CJK 的分词边界只留 0.035em 视觉微距；每行一个 hero 词放大到 1.34~1.6×、其余压到 0.7~0.86×，形成视觉重心，行高 1.02~1.12 保持紧凑，每字有独立入场向量（替代 sonnet 的散布式布局），`temperaBlocks.ts` 绘制大面积色块 MG 并兼作转场引导，`temperaCamera.ts` 只做 shot 级镜头（不追踪逐字），`temperaPalette.ts` 从主题派生 duo/mono 调色板。后处理复用 sonnet 的纯 GLSL filter（`sonnetLensFilter`/`sonnetGlitchFilter`/`sonnetPrintFilters`），其余不交叉引用。

运动统一走 `temperaMotion.ts`（cubic-bezier 缓动 + 逐字 solver）：逐字入场时长由该字到下一个字的时间间隔推出（0.34~1.35s），色块的 delay/span 是 shot 时长的比例而非固定秒数，因此动画节奏跟着歌词行推进；落位后有极小的确定性浮动，避免画面完全静止。每个 shot 有 `flowAngle`，相邻 shot 只小幅转向，色块进出场、镜头位移和转场（`block-wipe`/`camera-pan`/`shape-carry`）都沿同一方向，所以边界是「接力」而不是硬切；`block-wipe` 的色块按 0..2 连续行程扫过，1 为满覆盖，场景在满覆盖瞬间切换。Tempera 渲染层不消费音频（`audioPower`/`audioBands` 只传给共享背景层）。

视觉层为「网点图形」语言：`temperaHatch.ts` 是纯函数生成器（斜线 hatch、抖动涂鸦折线、重复符行列、贯穿斜线、纸面点阵），`temperaShapes.ts` 把它们变成静态 Pixi Graphics，`temperaCompositions.ts` 按 shot kind 组合构图，`temperaBlocks.ts` 只保留 enter/exit 运动状态。每个 shot 的 `decor`（motif、hatch 角度、贯穿线数量、碎字）在 `temperaProgram.ts` 编译期由 seed 定死，渲染层零随机。

文字反色由 `temperaDifferenceFilter.ts` 完成：它声明 `blendRequired`，读取 `uBackTexture`（filter 区域下层已渲染像素）的亮度，逐像素在 ink / paper 中选对比更强的一色。因此 filter 只挂在 textLayer 上（bounds 越小拷贝越少），叠影副本放在它下面的 underLayer 才会被当作底色读到；Tempera 没有 halo 泛光层——screen 混合的辉光会把字洗白，而且无论放在字上还是字下都会变成 filter 要读的底色；current-glyph 不画任何衬底块（衬底会变成 filter 读到的底色，结果就是一个纯色方块而不是对画面的反应），改用极小的缩放起伏表示当前字；runtime 的 `app.init` 需要 `useBackBuffer: true`，否则 WebGL 下整个 filter 栈会被 skip（文字退化为静态 ink 色）。反色**不挂在 `postProcessEnabled` 下**——那个设置默认 false，挂上去等于整个效果对绝大多数用户是死的；它是这个模式给文字上色的方式，始终生效，只有渲染器自己 skip 掉 filter 时才退化为静态 ink 色。`temperaPalette.ts` 的 `ensureInkContrast` 保证 ink 与 paper 的亮度差 ≥96，否则（主题把浅色 primary 配浅色背景时）反色只是在两个几乎相同的浅色之间二选一。

## Host surfaces

不要只在主播放器里验证 visualizer。统一 renderer 当前被这些宿主复用：

- `src/App.tsx`
- `src/components/modal/ThemePark.tsx`
- `src/components/visualizer/VisPlayground.tsx`
- `src/components/obs/ObsBrowserSourceApp.tsx`
- `src/components/obs/ObsWebSourceApp.tsx`

宿主可以提供不同的 `staticMode`、背景、面板和字幕 props，但模式契约仍来自 `definition.ts`。

## Runtime guardrails

- 连续播放时间优先使用 MotionValue、ref、CSS/Motion、canvas 或 Pixi draw loop；不要每帧写 React state/store。
- React state 只保存当前行、播放状态、可见段落等离散变化；高频 `requestAnimationFrame`、`useMotionValueEvent`、`ResizeObserver` 必须有相等保护和 cleanup。
- 布局 cache key 要包含歌词内容、主题、最终字重、窗口尺寸和 mode tuning；字体测量和最终渲染必须使用同一 `resolveThemeFontWeight` 结果。
- 新模式应复用 `runtime.ts`、`registry.tsx`、`VisualizerShell.tsx`、共享 subtitle/harmony overlay 和 `entry.tsx` settings contract。
- 新功能若让单个模式文件继续明显膨胀，加载 `file-modularization` skill，把 layout、canvas/Pixi、tuning 和纯计算拆到同目录文件。

## Fast lookup

```powershell
rg -n "VisualizerRenderer|VisualizerSharedProps|VisualizerMode|import.meta.glob|applyVisualizerTuning" src/components/visualizer src/types.ts
rg -n "getLineRenderHints|getLineRenderEndTime|buildPostLyricLayoutUnits|buildLineGraphemeTimeline" src/components/visualizer src/utils/lyrics
rg -n "Pendolo|Sonnet|Diorama|Pixi|Canvas|pretext" src/components/visualizer
```

先看命中的入口和相邻 helper；只有需要修改具体模式时才继续读取该模式目录。
