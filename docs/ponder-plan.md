# 思索（Ponder）教程清单

这份清单记的是「哪些地方该有教程、哪些教程的说法和真实行为对不上」。

为什么要有它：思索的目标是声明式数据，写错了不会有任何类型错误，缺一个目标也不会有任何东西报警 ——
只有人翻到那儿发现没有，或者照着字幕做了一遍发现做不成。所以覆盖面和准确性只能靠一份手写的账。

判断「值得单独讲」的标准：

- 藏在悬停 / 长按 / 右键 / 拖放后面，静态画面上看不见
- 和别的播放器的习惯不一样
- 一处控件镜像另一处配置，改一处两处都变
- 有前置条件才出现（某个来源才有、某个开关开了才有）
- 命名不自解释，或者同一屏里两个选项互斥
- **会改动或删除用户数据，做错了不可逆**

---

## 已完成

### 机制

- [x] 章节自动续播：一章播完读条 5.2s 进下一章；暂停、指针移到「下一章」上、按任意键都取消；末章不读条
- [x] 悬停提示胶囊写出目标名称（第二行，强调色）
- [x] 思索图标统一成灯泡（`PonderHintCapsule` / `PonderChrome` 此前是键盘图标）
- [x] `PonderSceneAction` 增加 `openUrl`，章节可以带一颗打开外部链接的按钮

### 右侧控制面板

- [x] 骨架重画：删掉封面和标签排之间那条不存在的「曲目信息」带；四页内容按真实组件重画
- [x] `panel-cover-actions` — 封面四角那四颗悬停才出现的按钮
- [x] `panel-cover-tab` / `panel-controls-tab` / `panel-queue-tab` / `panel-account-tab` — 一页一个目标
- [x] `panel-source-tab` — 跟着来源走的那一格（本地 / Navidrome / 在线歌词共用一格）
- [x] 文案修正：控制页的音量增益与歌词偏移其实在来源页、队列页不能拖动排序也没有「清空」、账号页的缓存清理已被注释掉

### 设置

- [x] `lyrics-animation-settings` 骨架与文案重做（两个开关同属一张卡；调参台是左预览右设置栏，原文左右说反了）
- [x] `theme-settings` 骨架与文案重做（Theme Park 是编辑器不是配色库；来源只有两个选项；补上下半截三个开关）
- [x] `grid3d-card-style` — 首页卡片样式
- [x] `grid-view-card-settings` — 网格卡片（全画幅封面解锁正方形卡片；两条滑杆调的是衰减下限）
- [x] `lattice-style-settings` — 队列拼贴（暗角 + 层层嵌套的海报叠色）

### 入门

- [x] `help-page` 重写成入门教程，帮助页那颗灯泡按钮直接开它
- [x] 六章：你已经在思索里了 / 整页教程与触屏那颗灯泡 / 不用切回来也能控制播放 /
      四个常用快捷键 / 去文档 / 看够了把提示关掉
- [x] 入门教程换掉通用页面轮廓，改画一张讲思索本身的示意图（`ponder-onboarding`）：
      一页界面、指针停着的那个组件、浮出来的提示胶囊、右下角触屏用的灯泡，再加教程接管整屏的那一层
- [x] 触屏灯泡的说法改准：它只在 `(any-pointer: coarse)` 下渲染，用鼠标找不到是正常的
- [x] 触屏灯泡从右下角搬到右上角 —— 右下角是底部控制条、集合页列表按钮、播放页手柄挤在一起
      的地方，一颗常驻浮动按钮压上去就是挡路
- [x] 灯泡改成限时显示：落地或换页露 4 秒就收，点右上角热区唤回；热区按坐标判而不是摆元素，
      摆元素等于把「挡路」原样搬到右上角
- [x] 设置里可以彻底关掉这颗按钮（设置 · 实验室 → 思索教程提示），命令面板也有对应开关

### 集合页与本地曲库

- [x] `pages.gridViewActivate` 文案修正 —— 点卡片只把它移到中央，播放靠卡片上那颗独立的播放键；
      编辑模式下那两颗按钮直接消失，只剩一个移除用的叉
- [x] `grid-action-button` — 右下角那颗按钮：点击开列表、向左滑是第二个动作、滑到哪由设置决定
- [x] `grid-view-edit-mode` — 编辑模式：卡片按钮整排换掉；本地与 Navidrome 歌单改名退出时才提交
- [x] `local-folder-actions` — 信息面板底部那一列：这一列有什么取决于集合类型；重扫是增量；红的那颗会删记录
- [x] `local-metadata-match` — 三重条件才出现的那颗铅笔
- [x] `local-track-sorting` — 只有本地文件夹能排序，选择存 localStorage 跨会话保留

### 文案事实性错误

- [x] `pages.playerShuffleHow`、`pages.playerExecuteMode`、`commandPalette.executeEnter` —— 冒号是**窗口关着时**按的，`{{mod}}+K` 之后再按只会打进输入框
- [x] `playerBar.volumeIntro` —— 控制页有常驻音量滑杆，应为「底部控制条上没有」
- [x] `playerBar.basicsPlay` —— 播放键只在宽屏时在最左端
- [x] `pages.latticeBack` —— 硬写 Ctrl/Cmd，全仓只有这一条不用 `{{mod}}`
- [x] `pages.playerPaletteOtherWays` 补上「焦点空闲时裸按 S」

---

## 待办

### 第一批 · 命令面板

- [ ] `queue-command-surface` — 队列命令窗口：`@artist:` / `@album:` facet 语法是全仓唯一一处
      没有按钮能替代的语法；`--remove` 作用于**筛选结果**而不是选中项，误按能一次清掉几十首。
      落点 `[data-testid="command-palette-queue-view"]` 已存在

### 第二批 · 设置（零新增 DOM，锚点都已存在）

- [ ] `transition-settings` — 渐变与自动混音：选了 automix 可能悄悄回落到 crossfade，
      唯一提示是一枚 `FELL BACK` 徽章；开关还镜像在控制页那颗 14px 的 Blend 图标上
- [ ] `local-library-watch` — 本地文件夹监视：监视列表里 `Eye` / `AlertTriangle` 两种状态，
      警告态意味着这个文件夹的监视已经失效
- [ ] `queue-settings` — 加入队列的默认行为：改的是全应用所有「加入队列」的语义
- [ ] `lyrics-settings` — 歌词来源与时间轴：「自动择优」会覆盖手动选的来源；
      全局偏移和来源页那个单曲偏移同名、不同作用域、会相加
- [ ] `interaction-settings-palette-hotkey` — 网格上的 S 归命令窗口还是归筛选
- [ ] `custom-shortcut-settings` — 自定义快捷键：修饰键固定 Alt，命令列表被
      `isScopeIndependentCommand` 过滤过，两件事界面上都没写
- [ ] `pinned-commands` — 固定命令：和「最近用过的排前面」是两套机制
- [ ] `replay-gain-settings` — 和来源标签页里那个三选一是同一个值
- [ ] `import-export-settings` — 「备份与导入」只导配色主题和歌词动画设置，不是全量备份

### 第三批 · 需要先加 data 属性

- [ ] `audio-equalizer` — 拖任何一根推子会**静默**把你转到自定义槽 1 并写进去
- [ ] `vis-playground` — 预览上有三块零像素的点击热区，不悬停永远发现不了
- [ ] `theme-park` — 整屏的配色编辑器，值得单独演一遍

### 第四批 · 补现有目标的缺章

- [ ] `panel-queue-tab` 加一章：FM 模式下这一格变成电台面板
- [ ] `panel-controls-tab` 加一章：两行取景器的中间名称可点开完整列表
- [ ] `player-bar` 加一句：暂停且不在首页时胶囊会自动展开，不是只有悬停才展开

---

## 验证链

每批都跑这三条：

```
npx vitest run -c vitest.config.ts test/unit/ponder
npx playwright test --project=components test/component/ponderPageSurfaces.spec.ts
npx playwright test --project=e2e test/ui/ponder.spec.ts
```

`test/component/lattice.spec.ts` 有几条随机失败的用例，和思索无关。
