# 新增 visualizer 模式：Tempera（visualizerTempera）
## 目标
新增一个与 sonnet 同族（PixiJS、日式歌词 PV、pretext + Intl.Segmenter 精确排版）但视觉路线不同的模式：
- **确定性排版**：歌词逐字出现在稳定的排版区域（非 sonnet 的随机散布 layout）。
- **色块分割 PV 风格**：大面积色块、裁切、优雅简洁几何元素、图层叠加、投影/发光、丰富转场。
- **调色**：从 DualTheme 当前主题经 `colorMix`（`mixColors` / `colorWithAlpha`）派生调色板；提供 mono（黑白灰）模式。
- **摄影机**：追踪当前 shot（分镜级运动），不追踪逐字动画；shot 之间由大面积图形引导自然切镜（如从上摇到下）。
命名约定（与 sonnet 对齐）：mode id `'tempera'`，组件 `VisualizerTempera`，labelKey `ui.visualizerTempera`，中文名「蛋彩」/英文「Tempera」。
## 架构决策
**复制 sonnet 骨架、重写排版与 MG 视觉层，不重构 sonnet。**
- 照搬骨架（改名 tempera，逻辑与排版无关）：React 外壳、Pixi runtime 生命周期（ticker/resize/destroy/scene 缓存 ±1）、program 编译管线（段落切分/分类/shot 分组/seed 确定性）、转场帧纯函数、后处理挂载链、纹理池、设置面板样板。
- 复用共享工具（不复制）：`useVisualizerRuntime`、`getLineRenderEndTime`/`getLineRenderHints`、`buildLineGraphemeTimeline`（`src/utils/lyrics/graphemeTiming.ts`）、`prepareWithSegments`/`layoutWithLines`（@chenglou/pretext）、`resolveThemeFontStack`/`resolveThemeFontWeight`、`mixColors`/`colorWithAlpha`。
- 后处理 GLSL filter（`sonnetLensFilter`/`sonnetGlitchFilter`/`sonnetPrintFilters`）是纯 GLSL 工厂、与 sonnet 排版无关：**直接 import 复用**，不复制（reuse-project-utilities 规则）。
- 全部"随机"走 seed hash（FNV-1a 模式照抄 `sonnetRandom.ts` 约 30 行），无 `Math.random`，保证 seek 安全与确定性。
## 第一部分：新建 `src/components/visualizer/tempera/` 目录
新文件头部按仓库规则在 import 后插入文件路径注释；复杂函数附简短功能注释。
1. **`types.ts`** — `TemperaProgram` → `TemperaParagraph` → `TemperaShot`（`id, kind, startTime, endTime, lineIndices, camera {x,y,zoom,rotation}`）→ `TemperaSegment { text, startOffset, endOffset, startTime, endTime, graphemes }`。结构仿 `sonnet/types.ts` 精简版。
2. **`temperaRandom.ts`** — `hashTemperaSeed` / `mixTemperaSeed` / `temperaHash01` / `chooseWithoutRepeat`（照搬 sonnetRandom 模式）。
3. **`temperaPalette.ts`** — 核心新增：`resolveTemperaPalette(theme, tuning)` 从 `theme.backgroundColor/primaryColor/accentColor/secondaryColor` 经 `mixColors`/`colorWithAlpha` 派生 `{ paper, ink, blockA, blockB, blockC, accent, line, shadow }`；`colorMode: 'duo' | 'mono'` 时 mono 派生为黑白灰阶梯（ink↔paper 混合档位）。pixi 侧统一 `pixi.Color.shared.setValue().toNumber()`。
4. **`temperaProgram.ts`** — `compileTemperaProgram(lines, seed)`：复用段落切分思路（metadata/time-gap 边界，`getLineRenderEndTime` 截尾），shot 分组（≤4 行或 ≤6s），从 **`TEMPERA_SHOT_KINDS`** 确定性选 kind（`chooseWithoutRepeat`）：
   - `duo-split`：上下/左右两大色块分割，文字沿分割带逐字出现
   - `band-strip`：横向宽色带（参考用户截图 1 的灰带），文字置于带内
   - `frame-window`：描边窗口/菱形框裁切，文字在框内（参考截图 2）
   - `poster-panel`：倾斜大色块海报，文字块压色块
   - `quiet-line`：细线网格 + 小字号整行（换气段用）
   每 shot 生成 camera 起始/结束帧（缓慢 pan/zoom/rotation）。
5. **`temperaLayout.ts`** — Tempera 排版引擎（重写核心，替代 sonnetTypographyLayout）：每种 shot kind 定义**固定排版区域**（如分割带上居中横排、框内居中、海报块左对齐块）；用 pretext（`prepareWithSegments`+`layoutWithLines`）测量行宽/换行，超界 fitScale 收缩；`Intl.Segmenter`(word) 切词 + `buildLineGraphemeTimeline` 拿逐字时序；逐字沿区域基线 advance 放置，输出 `TemperaGlyphPlacement[] { char, x, y, rotation, startTime, settleTime, fontSize }`。字重经 `resolveThemeFontWeight(theme, modeFallback)`，进入测量规格与缓存 key。
6. **`temperaBlocks.ts`** — 色块/几何 MG 层（替代 sonnetShotMg*）：每 shot kind 绘制大面积色块、裁切条、细线、×/方点等极简装饰；返回约定同 sonnet（`{ container, updateTime(time, ...) }` 鸭子类型），带 enter/exit 进度驱动的色块滑入/裁切展开动画；大面积图形兼作**转场引导物**（如下一 shot 的色块从上方带入，镜头随之下摇）。
7. **`temperaTextView.ts`** — Text-per-grapheme Pixi 节点（仿 `buildSonnetTextView` 精简）：TextStyle（palette 墨色 + dropShadow 投影/泛光）、可选描边、逐字入场（位移+alpha+scale 微弹）、current-glyph 高亮（accent 色或反白色块衬底）。
8. **`temperaTransitions.ts`** — 转场纯函数 + 图形转场：保留 sonnet 的 `fast-blur`/`mono-glitch` 思路，新增 `block-wipe`（大色块扫过遮罩切镜）与 `camera-pan`（镜头随大图形纵向/横向摇移）。输出帧 `{x,y,scale,rotation,alpha,blur,wipe}` 由 runtime 写入 scene container transform 与 filter uniform。
9. **`temperaCamera.ts`** — shot 级摄影机：`resolveShotCameraFrame(shot, progress)` 每 shot 一条手调缓慢路径（pan/zoom/rotation），**不含逐字追踪**；加 breath 微浮动（仿 `resolveSonnetCameraBreath`）。
10. **`createTemperaPixiRuntime.ts`** — 仿 `createSonnetPixiRuntime`：懒加载 pixi.js、`app.init`（`backgroundAlpha: 0`、`textureResolution`）、三层 stage（scene/credits/overlay）、ticker 每帧按绝对 `currentTime.get()` 突变场景（seek 安全）、scene cache ±1 + 剪枝、`ResizeObserver` 尺寸变化全量重建、paused 时 `renderOnce`、destroy 契约（filters→container→texture pool→`app.destroy`）。对 React 只暴露 `destroy/setSongMetadata/setPaused/renderOnce`。
11. **`temperaSceneBuilder.ts`** — 段落 → SceneView：组装 blocks 层 + 文字视图 + halo 泛光层（BlurFilter + screen blend）+ 后处理链（import sonnet 的 lens/glitch/print filter + 内置 Noise/Contrast/Vignette）。
12. **`VisualizerTempera.tsx`** — React 外壳（仿 `VisualizerSonnet.tsx`，≤250 行）：instrumental 兜底（虚拟 `♪` 行）、`useMemo` 编译 program、`useEffect` 动态 import 创建 runtime（deps 变化全量重建）、`VisualizerShell` + `VisualizerSubtitleOverlay` 接线、DOM 大字 fallback。
13. **`tuning.ts`** — `defineVisualizerTuning({ mode: 'tempera', settingsKey: 'temperaTuning', settingsSetterKey: 'handleSetTemperaTuning', apply })`（glob 自动收集）。
14. **`entry.tsx`** — `defineVisualizer({ mode: 'tempera', order: 71, labelKey: 'ui.visualizerTempera', labelFallback: 'Tempera', previewSeed: 'tempera', previewStartOffset: 0, tuningKind: 'tempera', render, renderSettingsPanel, resetSettings })`。
15. **`TemperaSettingsPanel.tsx` + `TemperaSettingsControls.tsx`** — 仿 sonnet 面板：分区（动效/显示/画质/后处理），控件复用 SonnetSettingsControls 的同款 DOM 模式（slider/toggle/select）。
**`TemperaTuning`（放 `src/types.ts`，仿 `SonnetTuning` 精简）**：`cameraIntensity`、`glyphMotion`、`colorMode: 'duo'|'mono'`、`showBlocks`、`showDecor`、`enableTransitions`、`textureResolution`、`postProcessEnabled` + grain/contrast/rgbShift/vignette/lensDistortion。+ `DEFAULT_TEMPERA_TUNING`。
## 第二部分：接线改动（按 sonnet 模板逐点）
1. `src/types.ts` — `TemperaTuning` + `DEFAULT_TEMPERA_TUNING`（:524-554 附近；`VisualizerMode` 开放联合不用动）。
2. `src/components/visualizer/definition.ts` — `VisualizerTuningKind` 加 `'tempera'`；`VisualizerSharedProps`/`VisualizerSettingsPanelProps` 加 `temperaTuning?`/`onTemperaTuningChange?`；`VisualizerSettingsResetProps` 加 `resetTemperaTuning?`/`setDraftTemperaTuning?`。
3. `src/components/visualizer/tuningRegistry.ts` — import + `VisualizerTuningMap` 加 `tempera: TemperaTuning`（:11, :30）。
4. `src/stores/useSettingsUiStore.ts` — import、`readStoredTemperaTuning`（localStorage `tempera_tuning`，逐字段校验钳制）、state 字段 + handler 类型 + 初始值、`handleSetTemperaTuning`/`handleResetTemperaTuning`、selector 导出（模板 :492-543, :2237-2282 等 8 处）。
5. `src/App.tsx:340,451` — 解构 `temperaTuning` + `visualizerTunings` bundle 加 `tempera`。
6. `src/components/modal/SettingsModal.tsx` — 5 处（:197, :272-273, :1838, :1893-1894, :1925）。
7. `src/components/visualizer/VisPlayground.tsx` — 9 处通用 tuning 接线（:86, :141, :310, :424, :532, :581, :640-644, :982-990, :1253）。
8. `src/components/visualizer/VisPlaygroundSettingsPanel.tsx` — 4 处（:14, :105-106, :365-366, :716-717）。tempera 自算字号，仿 sonnet 加「禁用通用字号 + 提示」特例（:484-528）。
9. `src/components/modal/settings/AppearanceSettingsSubview.tsx` — 3 处（:173, :217, :474）。
10. `src/utils/appearanceCodec.ts` — compress/decompress 短 key（挂 `tmp`）+ validKeys（:357-400, :452, :564, :585）。
11. `src/utils/appearanceImportPlan.ts` — 分组 map + 两个 key 数组（:92, :153, :173）。
12. `src/utils/visualSettingsConfig.ts:77` — `temperaTuning: store.temperaTuning`。
13. `src/components/modal/settings/ImportConfirmDialog.tsx:97` — `KEY_TO_MODE` 加 `temperaTuning: 'tempera'`。
14. `src/components/command-palette/commandRegistry.ts:648` — `createVisualizerCommand('tempera', 'Visualizer: Tempera', ...)`。
15. i18n `src/i18n/locales/zh-CN.ts` + `en.ts` — `notifications.temperaReset`、`commands.items.visualizer-tempera`、`ui.visualizerTempera`、`options.tempera*`（设置面板全部文案；in.ts 跳过，fallback 英文）。
16. `src/services/sync/syncTypes.ts:61`、`syncSchema.ts:84`、`settingsSnapshot.ts:43,106` — 单字段 legacy 条目（主通道 visualizerTunings bundle 已自动）。
17. `src/components/panelTab/controls/modeGlyphs.tsx` — 加 tempera glyph（:105-110 模板）。
18. 文档：`src/components/visualizer/README.md` 模式表 + Sonnet 节后加 Tempera 节；`src/README.md:95` 清单。
19. `test/unit/visualizer/tuningRegistry.test.ts:12-24` — 模式清单断言加 `'tempera'`。
**自动生效、无需改动**：registry/tuning glob 发现、VisualizerRenderer 分发、模式下拉 ×3、随机轮换/步进、OBS `hasVisualizerMode`、同步主通道 bundle、modeGlyphs fallback。
## 第三部分：测试与验证
1. 新增 `test/unit/visualizer/temperaProgram.test.ts`：段落切分、shot kind 确定性（同 seed 同结果、无重复相邻 kind）、segment `join('') === fullText`、时序边界。
2. 新增 `test/unit/visualizer/temperaPalette.test.ts`（小）：duo/mono 派生对比度与确定性。
3. 更新 `tuningRegistry.test.ts`；跑 `npm run test:unit -- test/unit/visualizer` 及涉及接线的单测（appearanceCodec/visualSettingsConfig/settings store 相关）。
4. 手动验证：VisPlayground 选 tempera 预览（用户侧 dev server 热加载确认，不主动跑 build）。
## 明确不做
- 不重构/抽共用 sonnet 代码（保持最小侵入；仅 import 其 3 个纯 GLSL filter）。
- 不加 DevDebugOverlay 的 tempera tab。
- 不碰 `settingsPanels.tsx`（老模式共享面板）、`in.ts`、Electron 侧。

---

# v2 视觉重设计：网点图形 MV 风（screentone graphic）
## 起因
v1 色块分割版落地后偏单调：大面积平涂色块 + 极简细线，信息量低。参考两张黑白网点风 MV 截图（斜线网点心形 + 同心菱形框 + 贯穿斜线；实心黑菱形 + ✕✕✕ + 横带反白文字 + 涂鸦笔触），把 Tempera 的 MG 视觉层整体升级为「网点纸图形」语言。**排版引擎、program 编译管线、runtime 骨架不动**，只重写视觉层。

## 从参考图提炼的设计母题
1. **网点/斜线填充**：几何形内部用斜线 hatch 或网点填充替代平涂；密度阶梯（粗→细、疏→密）表达明暗，同一形状可上半渐变 tone、下半实心。
2. **同心菱形/方框描边**：2~3 层旋转 45° 的方框套叠，粗细描边交替（外粗内细），可只有框无填充。
3. **贯穿斜切直线**：1~3 条细直线以小角度（±4°~10°）横贯整个画面，超出边界，作为构图引导。
4. **重复装饰符**：`✕✕✕✕` 一排、`▪ ▪ ▪` 小方块列、等距圆点串，沿直线排列，部分被色块/边缘裁切。
5. **手绘涂鸦笔触**：抖动折线（jitter polyline）画出的潦草线圈、草丛状短线簇、画面底部的波浪边缘线——用 seed 驱动的抖动模拟手绘，不用真实贴图。
6. **横带反白**：画面中部一条中灰横带压在所有图层之上，带内文字反白（带色=中调、字色=paper）。
7. **叠影文字**：主文字后垫一层 x/y 偏移的 shadow 色副本（硬阴影，不模糊），印刷套版感。
8. **碎字散布**：非当前行的残句单字以小字号散落在角落/边缘，部分出血裁切（break/outro/quiet 段用）。
9. **mono 为旗舰观感**：参考图是纯黑白灰；duo 模式复用同一亮度阶梯映射到主题色，不改变构图。

## 改动清单（按文件）
### 1. `temperaHatch.ts`（新文件，纯函数生成器）
- `buildHatchSpec(seed, salt) → { angle, spacing, width }`：斜线 hatch 参数。
- `buildScribblePath(seed, salt, cx, cy, radius, turns) → number[]`：抖动折线点列（每点从 `temperaHash01` 取 ±jitter），用于涂鸦圈/波浪边。
- `buildCrossRow(seed, count, spacing) / buildDotRow(...)`：重复符位置序列。
- 全部纯函数、seed 确定，供 blocks/textView 调用并单测。
### 2. `temperaBlocks.ts`（重写视觉，保留接口与 updateTime 契约）
- 新增内部绘制 helper：`hatchFill(graphics, path, spec)`（clip + 平行线组）、`diamondOutline(cx, cy, r, strokeWidth)`、`crossingLines(count, angleRange)`、`wavyEdge(y, amplitude)`。
- 五种 shot kind 重新构图（保留 kind 名与排版区域不变，只换视觉）：
  - `duo-split` → 分割带不变，但两区分别用**斜线 hatch**与**网点填充**；分割线上加同心菱形小框。
  - `band-strip` → 中灰横带 + 带上下各一条贯穿斜切线 + 带外一侧 ✕ 一排（对齐参考图 2）。
  - `frame-window` → 2~3 层同心菱形/方框套叠描边（粗细交替），框内淡 hatch，角部 ✕ 或 ▪ 列。
  - `poster-panel` → 倾斜大菱形实心 ink 色 + 相邻 hatch 菱形交叠 + 底部波浪边缘线。
  - `quiet-line` → 细线网格保留，加涂鸦线圈/草簇短线 + 角落碎字位置标记。
- 新增跨 shot 通用层 `buildCrossingLinesLayer`：1~3 条小角度贯穿直线，所有 kind 共用（参考图 1 的构图骨架）。
- enter/exit 动画保留现有 delay/span 机制；hatch 图形可以做「密度展开」（线条从 0 长到全长的 scaleX 展开）。
### 3. `temperaTextView.ts`（叠影 + 动态反色）
- 每个 glyph 增加硬阴影副本：偏移 (0.06em, 0.08em)、palette.shadow 色、置于主文字下层，随主文字同步动画（同一 timeline，不加额外状态）。
- ~~band-strip 手动反白~~ → 改为由 **difference 反色 filter** 统一处理（见下文「v2 补充」），textView 不再按 kind 换字色；current-glyph 高亮块保留（衬底在 filter 容器内，随文字一起反色）。
- 碎字散布：`quiet-line`/`outro` 段落把非当前行 segment 的单字按 seed 散在四角（小字号、低 alpha、可出血），时序上整段常驻。
### 4. `temperaPalette.ts`（亮度阶梯扩展）
- 新增 `tone1..tone4`（paper↔ink 的 0.12/0.30/0.52/0.72 档），专供 hatch 密度与图形明暗映射；mono 为纯灰阶梯，duo 用 `mixColors(paper, accentColor/secondaryColor, 档位)` 映射同阶梯。
- 保留现有字段不变（向后兼容，不动 settings/sync/codec 接线）。
### 5. `types.ts`（decor 描述入 program）
- `TemperaShot` 增加 `decor: TemperaDecorSpec`：`{ motif: 'diamonds'|'hatch-twin'|'band-cross'|'poster-diamond'|'doodle', hatchAngle, crossCount, scribbleSeed, fragments: Array<{char,x,y,rotation,scale}> }`——全部在 `temperaProgram.ts` 编译期由 seed 确定，渲染层零随机。
### 6. `temperaProgram.ts`（小改）
- 编译 shot 时生成 `decor`（`chooseWithoutRepeat` 选 motif，hash 取参数）；碎字从段落内非当前行文本取字。
- 段落切分/shot 分组/时序逻辑一行不动。
### 7. `temperaSceneBuilder.ts`（纸面质感）
- 背景层加低强度网点纸纹理：用 hatch helper 画一层 alpha≈0.05 的细点阵铺满，随 scene 缓存复用（每 shot 一张，无逐帧成本）。
- 后处理链不变（grain/print filter 已提供颗粒）。
### 8. `temperaCamera.ts` / `createTemperaPixiRuntime.ts`
- camera 不动；runtime 需小改（`useBackBuffer: true`），见下文「v2 补充」。转场 `block-wipe` 的遮罩图形可换成菱形 wipe（可选，放最后做）。
## 不做
- 不改排版区域与逐字时序逻辑（temperaLayout 的区域定义不变）。
- 不新增 tuning 设置项（复用 `showDecor`/`glyphMotion`/`colorMode`），避免二轮设置/sync/i18n 接线。
- 不动 sonnet；不使用任何外部贴图/字体资源。
- 不主动跑 build / 不起 dev server；浏览器实测留给用户热加载。
## 测试
1. `test/unit/visualizer/temperaHatch.test.ts`（新）：hatch/scribble/crossRow 生成器确定性（同 seed 同输出、不同 seed 不同、点列有界）。
2. `temperaProgram.test.ts` 补：shot.decor 确定性与 motif 相邻不重复、fragments 字符来自段落文本。
3. `temperaPalette.test.ts` 补：tone1..tone4 单调递增亮度、mono 下为纯灰。
4. 跑 `test/unit/visualizer` 全套 + `tsc --noEmit`。

---

## v2 补充：difference 动态文字反色 filter
### 目标
文字压在色块/hatch 图形上时**逐像素动态反色**（参考图横带上白下黑的套版感），而不是按 shot kind 手动指定字色。
### 技术选型（已调研 node_modules/pixi.js@8.19.0 源码确认）
- **不做**：`container.blendMode = 'difference'`（`pixi.js/advanced-blend-modes` 的 `DifferenceBlend`）。它是 `abs(front - back)` 的纯差值——文字压在 50% 中灰横带上时结果还是 ~50% 灰，**不可读**；且不可调阈值。
- **做**：自写 `temperaDifferenceFilter`（仿 `sonnetLensFilter` 的单 pass GLSL 工厂模式），核心逻辑为**阈值二值反色**：
  ```glsl
  uniform sampler2D uTexture;      // 文字层自身像素
  uniform sampler2D uBackTexture;  // filter 区域下层已渲染像素（背景快照）
  // 对 back 取亮度，亮底→ink 色、暗底→paper 色，front.a 作为文字遮罩
  vec4 back = texture(uBackTexture, vTextureCoord);
  float lum = dot(back.rgb / max(back.a, 1e-4), vec3(0.2126, 0.7152, 0.0722)); // 去预乘后取 Rec.709 亮度
  vec3 inverted = mix(uInkColor, uPaperColor, step(uThreshold, lum));
  finalColor = vec4(inverted * front.a, front.a); // 保持预乘输出
  ```
  - `uInkColor`/`uPaperColor`/`uThreshold`（默认 0.5）走 UniformGroup；palette 变化时重建 filter 或写 uniform。
  - 阈值反色保证任何底色上文字都满对比；`uThreshold` 可调防止 hatch 细密区闪烁（可加 1px 邻域采样取均值再 step，做轻微抗闪）。
### pixi 侧 buffer 要求（重点，源码核实）
1. **WebGL 必须开 back buffer**：`FilterSystem._calculateFilterBounds` 里 `filter.blendRequired && !(renderer.backBuffer?.useBackBuffer ?? true)` 不满足时**整个 filter 栈被 skip 并 warn**（"Blend filter requires backBuffer on WebGL renderer..."）。→ `createTemperaPixiRuntime.ts` 的 `app.init` 加 `useBackBuffer: true`（WebGPU 下 `backBuffer` 为 undefined，走 `?? true` 天然放行）。fallback：被 skip 时文字退化为静态 ink 色，功能可用，可接受。
2. **filter 声明**：`new pixi.Filter({ glProgram, blendRequired: true, resources: { differenceUniforms, uBackTexture: pixi.Texture.EMPTY } })`。`blendRequired: true` 时 Filter 构造器自动把 `uBackTexture` 绑到 group 0 binding 3，但 resources 里必须像 `BlendModeFilter` 一样先放 `Texture.EMPTY` 占位。
3. **采样坐标**：`uBackTexture` 与 `uTexture` 用**同一个 `vTextureCoord`**（官方 blend-template.frag 即如此），无需自行换算屏幕 UV。
4. **每帧 GPU 拷贝成本**：`blendRequired` 触发 `getBackTexture` → `renderTarget.copyToTexture` 把 filter bounds 区域拷到 TexturePool 纹理。**必须把 filter 挂在尽量小的容器上**——只挂 textLayer（glyph + 叠影副本所在的 inversion 容器），bounds 即文字排版区域；不要挂 scene root。
5. **挂载层级**：filter 必须在 scene 内部（blocks 之下渲染完成的同一 render target 内），这样 back 快照才包含色块/hatch 底图；**不能**放 scene root 的 post-process 链上（那里 back 是 stage 底层，基本为空）。halo 泛光层与后处理链保持在 filter 容器之外、之上。
6. **底色必须不透明**：back 是预乘 alpha，文字下方需有 paper 底（sceneBuilder 的纸面底层已覆盖），否则 alpha≈0 区域去预乘除零（shader 里已 `max(a, 1e-4)` 兜底）。
7. `padding: 0`、`resolution: 'inherit'`、`clipToViewport` 默认即可；反色无需向外采样。
### 文件落点
- 新文件 `temperaDifferenceFilter.ts`：`createTemperaDifferenceFilter(pixi, { ink, paper, threshold })` 工厂，结构对齐 `sonnetLensFilter.ts`（约 80 行）。
- `temperaTextView.ts`：textView 根容器（含叠影副本）挂 `filters = [differenceFilter]`；无时间 uniform，帧间零更新，seek 安全天然成立。
- `temperaSceneBuilder.ts`：组装时保证 paper 底层在最下、filter 容器在 blocks 之上、halo 在其上。
- `createTemperaPixiRuntime.ts`：`app.init` 加 `useBackBuffer: true`。
- 开关：复用现有 `postProcessEnabled`（关时 textView 不挂 filter，文字为静态 ink 色），**不新增设置项**。
### 测试补充
- `temperaDifferenceFilter.test.ts`：工厂返回 Filter 实例、`blendRequired === true`、resources 含 `uBackTexture` 占位（jsdom 下只验构造与属性，不跑 GL）。
