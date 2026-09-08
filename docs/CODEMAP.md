# 代码地图

<!-- 这份文件由 `npm run codemap` 生成，不要手改。CI 会重新生成并比对。 -->

全部内容由 TypeScript 编译器和模块图推导，不是人工维护的清单。
想知道某个具体符号在哪，用 `node dev/mcp/ts-code-map/cli.mjs search '{"query":"..."}'`。

文件里所有的量都只给**数量级**（向下取整到 2 的幂，写作 `512+`），排序也按量级。
这是有意的：精确计数会让每个新文件、每条 import 都产生一次同步提交，而那些提交
没有一条说明结构变了。要精确数字就问 `cli.mjs`，它是按需查询、不进版本库的。

## 区域分布

| 区域 | 文件数量级 |
| --- | --- |
| components | 512+ |
| test/dev | 256+ |
| services | 128+ |
| backend/electron | 64+ |
| hooks | 64+ |
| utils | 64+ |
| stores | 32+ |
| types | 16+ |
| 其他 | 16+ |
| src (其他) | 8+ |
| i18n | 4+ |
| workers | 2+ |

## 枢纽模块

被 32 个以上模块依赖的文件。改动它们波及面最大，读代码时也最值得先看。

| 被依赖量级 | 模块 |
| --- | --- |
| 512+ | `src/types.ts` |
| 64+ | `src/types/onlineMusic.ts` |
| 64+ | `src/utils/appPlaybackGuards.ts` |
| 32+ | `src/components/command-palette/types.ts` |
| 32+ | `src/components/visualizer/colorMix.ts` |
| 32+ | `src/components/visualizer/definition.ts` |
| 32+ | `src/services/db.ts` |
| 32+ | `src/services/onlineMusic/songMetadata.ts` |
| 32+ | `src/stores/usePlaybackStore.ts` |
| 32+ | `src/stores/useStatusMessageStore.ts` |
| 32+ | `src/utils/lyrics/renderHints.ts` |

## 动态注册点

这些地方用 `import.meta.glob` 自动发现成员，**清单随目录变化，不要手写**。
以下是当前的完整展开：

### `dev/probes/registry.ts`

- `dev/probes/audioEffectGrid.probe.tsx`
- `dev/probes/automixModelReminder.probe.tsx`
- `dev/probes/automixModels.probe.tsx`
- `dev/probes/automixTransitionSwitches.probe.tsx`
- `dev/probes/fmTab.probe.tsx`
- `dev/probes/globalLyricOffsetRuler.probe.tsx`
- `dev/probes/gridPanelToggle.probe.tsx`
- `dev/probes/lattice.probe.tsx`
- `dev/probes/latticePerformance.probe.tsx`
- `dev/probes/latticeTitle.probe.tsx`
- `dev/probes/latticeTitleExpansion.probe.tsx`
- `dev/probes/localFolderIgnore.probe.tsx`
- `dev/probes/lyricFilterModal.probe.tsx`
- `dev/probes/lyricSegmentationSurface.probe.tsx`
- `dev/probes/lyricStaffSection.probe.tsx`
- `dev/probes/monetPortraitImage.probe.tsx`
- `dev/probes/nowPlayingToastTransitionBorder.probe.tsx`
- `dev/probes/playbackLyricsSettings.probe.tsx`
- `dev/probes/playerBottomBar.probe.tsx`
- `dev/probes/settingsNavigation.probe.tsx`
- `dev/probes/themePark.probe.tsx`
- `dev/probes/trackTitleNavigator.probe.tsx`
- `dev/probes/visualizerMemory.probe.tsx`

### `src/components/visualizer/backgrounds/registry.tsx`

- `src/components/visualizer/backgrounds/common/entry.tsx`
- `src/components/visualizer/backgrounds/latent/entry.tsx`
- `src/components/visualizer/backgrounds/monet/entry.tsx`
- `src/components/visualizer/backgrounds/nomand/entry.tsx`
- `src/components/visualizer/backgrounds/sora/entry.tsx`
- `src/components/visualizer/backgrounds/url/entry.tsx`

### `src/components/visualizer/registry.tsx`

- `src/components/visualizer/cadenza/entry.tsx`
- `src/components/visualizer/cappella/entry.tsx`
- `src/components/visualizer/claddagh/entry.tsx`
- `src/components/visualizer/classic/entry.tsx`
- `src/components/visualizer/diorama/entry.tsx`
- `src/components/visualizer/fume/entry.tsx`
- `src/components/visualizer/monet/entry.tsx`
- `src/components/visualizer/partita/entry.tsx`
- `src/components/visualizer/pendolo/entry.tsx`
- `src/components/visualizer/sonnet/entry.tsx`
- `src/components/visualizer/still/entry.tsx`
- `src/components/visualizer/tempera/entry.tsx`
- `src/components/visualizer/tilt/entry.tsx`

### `src/components/visualizer/tuningRegistry.ts`

- `src/components/visualizer/cadenza/tuning.ts`
- `src/components/visualizer/cappella/tuning.ts`
- `src/components/visualizer/claddagh/tuning.ts`
- `src/components/visualizer/classic/tuning.ts`
- `src/components/visualizer/diorama/tuning.ts`
- `src/components/visualizer/fume/tuning.ts`
- `src/components/visualizer/monet/tuning.ts`
- `src/components/visualizer/partita/tuning.ts`
- `src/components/visualizer/pendolo/tuning.ts`
- `src/components/visualizer/sonnet/tuning.ts`
- `src/components/visualizer/tempera/tuning.ts`
- `src/components/visualizer/tilt/tuning.ts`

## 分层边界违规

规则是人定的（见 `codemap.mjs` 的 `BOUNDARY_RULES`），拿真实的值导入图去比对。
`import type` 不算——它在运行时不存在。

下面这些边的依赖方向本身就是错的：

- `src/stores/useVisualizerSettingsStore.ts` → `src/components/visualizer/registry.tsx`  —— store 不应依赖组件

### 目录归属存疑

这些边命中了规则，但目标模块在运行时根本不含 UI（不传递依赖 react）。
依赖方向没问题，是文件住在了 `src/components/` 下面。修法是移动文件，不是改依赖。

- `src/services/obs/visualSettingsConfig.ts` → `src/components/visualizer/tuningRegistry.ts`
- `src/services/sync/settingsSnapshot.ts` → `src/components/visualizer/tuningRegistry.ts`
- `src/stores/usePlaybackStore.ts` → `src/components/app/playback/createCoverUrlResolver.ts`
- `src/stores/useSettingsModalStore.ts` → `src/components/command-palette/pinnedCommandPreferences.ts`
- `src/stores/visualizerSettingsPersistence.ts` → `src/components/visualizer/diorama/dioramaMoteField.ts`
- `src/utils/themeColorMath.ts` → `src/components/visualizer/colorMix.ts`

