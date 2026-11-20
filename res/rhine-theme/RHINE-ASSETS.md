# RhinE 资源包（assets）与宿主层的约定

> 改编自 RhinE（<https://github.com/ericzhang12111-cell/RhinE>，v2.1.1，MIT）。本文件由 Folia 编写。

这份文件回答两个问题：913 MB 的 `theme/assets/` 为什么不在仓库里、以后怎么接；以及上游那套 foobar2000 形态的东西，在 Folia 的宿主层里怎么放。

跟进 issue：**#440**（「RhinE 主题资源包（913 MB assets）做成运行时可选下载」）。

## 资源包现在是什么状态

| | |
| --- | --- |
| 上游位置 | `theme/assets/` |
| 实测体积 | **913.52 MB，7082 个文件** |
| 参考：当前整个 `public/rhinelab`（老主题） | 10.72 MB，71 个文件 |
| 本轮处理 | 不搬、不下载、不打包。仓库里只有代码骨架（本目录，1.27 MB） |

主要内容与用途：

- `assets/render/`、`assets/render/*/case.json`：唱片盒（specimen case）的材质渲染，`js/lib/skins.js` 按文件夹读；
- `assets/wallpapers/`：05 STYLE › WALLPAPER；
- `assets/tags/`：05 STYLE › TITLE TAG 的标签渲染，`js/lib/tag.js` 用；
- `assets/intro/`：预渲染的开场动画；
- `assets/grain-dark.png`、`assets/grain-light.png`：颗粒贴图，`js/lib/grain.js` 用（这两张各 18 KB，真要抠出来内置也只有 36 KB，见 #440 的讨论）；
- `assets/fonts/`：Geist Mono，**SIL OFL 1.1，与主题的 MIT 分开授权**；
- `assets/golden.tokens.json` 之类的调色板样本：`tokens/tokens.json` 是它的文字版，已经在仓库里。

## 接口（本轮只留形状，不实现下载）

宿主侧与主题侧约定了下面这些，下载那一轮按它做，不要另起一套：

1. **URL 参数 `assets`**：`res/rhine-theme/index.html?assets=1` 表示资源包可用，缺省 / `0` / 别的值表示没有。`adapt/rhineHostConfig.js` 把它读成 `window.FOLIA_RHINE.assets`（`'downloaded' | 'bundled'`）与 `hasAssetsPackage`，并写到 `<html data-rhine-assets>` 上给 CSS 用。
2. **URL 参数 `assetsBase`**：资源根目录前缀，缺省 `''`（即页面同目录）。真的接了下载以后，资源落在哪个目录由宿主决定，主题只拼前缀。
3. **`postMessage` 的 `{ type: 'rhine-config', config: { assets, assetsBase } }`**：资源包在页面已经加载之后才就绪（或者被清除）时，宿主用这条消息通知，不用重新加载 iframe。`host-entry.js` 收到就地更新 `window.FOLIA_RHINE` 与 `data-rhine-assets`。
4. **主题向宿主回报 `{ type: 'rhine-theme-ready', degraded }`**：`degraded: true` 表示「跑起来了，但资源包不在」。宿主据此决定要不要盖上第一屏、要不要在界面上提示。

本轮**没有**实现的部分（都在 #440 里）：下载入口、进度与取消、落盘位置、校验、断点续传、清除。所以现在没有任何代码会去请求 `assets/` 下的文件 —— 这正是「没下载也能用」的前提。

## 降级规则（接入资源包时不许破坏）

- 任何一件来自 `assets/` 的东西缺失，都必须退回**纯色 / 占位**，不许留白块、不许抛错、不许让整个主题起不来；
- 页面壳（`index.html` + `adapt/*`）永远不依赖资源包；
- 新增「需要资源」的样式时，按 `adapt/rhineFallback.css` 的写法办：底色写死，贴图作为可选的 `background-image`。贴图 404 就是底色，天然可降级。

## 宿主层（Folia）的终态约定

文档 `THEME-LAYERING.md` 里写的分层。一句话：**改装的东西只进 `adapt/`，主题代码（`js/`）按原样留档，宿主自己的界面用 Folia 的控件。**

- 需要改行为的地方（例如把 `fb` 的播放控制翻译成宿主回调），写一个新的 `adapt/` 文件，不去改上游文件；这样上游升级时能直接对比 diff。
- 三份「看着像但宿主不同」的东西不进仓库：foobar2000 的安装脚本（`install.ps1` / `install.cmd`）、自更新清单（`theme/update/`）、以及把上游界面原样嵌进来的构建产物（老主题 `public/rhinelab/` 就是那一种，见 `THEME-LAYERING.md`）。
