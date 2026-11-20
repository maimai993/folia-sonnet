# RhinE — 来源与改编说明

> 改编自 RhinE（<https://github.com/ericzhang12111-cell/RhinE>，v2.1.1，MIT）。本文件由 Folia 编写。

本目录是「莱茵生命」主题的代码骨架，搬到 Folia 时**逐字复制**自上游 RhinE 2.1.1，下面写清楚每一份的出处、改了什么、为什么。

| 项 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/ericzhang12111-cell/RhinE> |
| 版本 | 2.1.1（`VERSION`，出处为上游 `theme/VERSION`） |
| 作者 | the Audio Archive authors（上游 `LICENSE` 的版权署名） |
| 许可证 | MIT，全文在同目录的 `LICENSE` |
| 搬入日期 | 2026-11-19 |

RhinE 是一个 **foobar2000（Columns UI + JSplitter）主题**，不是网页主题：`js/` 里的脚本跑在 foobar2000 的面板运行时里，依赖 `fb`、`plman`、`utils`、`include()` 这些宿主提供的全局。Folia 里没有这些东西，所以这份骨架的作用是**把代码和素材先落到仓库里、接上入口**（第一轮，见 issue #421），不是「已经能渲染出上游那五个视图」。谁在扩展这里之前，请先读下一节。

## 搬了什么

| 目录 | 出处 | 大小 | 改了什么 |
| --- | --- | --- | --- |
| `js/` | 上游 `theme/js/` | 1.09 MB | 没改 |
| `columns/` | 上游 `theme/columns/` | 0.12 MB | 没改 |
| `tokens/` | 上游 `theme/tokens/` | 0.01 MB | 没改 |
| `online/` | 上游 `theme/online/` | 0.21 MB（去掉 `package-lock.json`） | 见下 |
| `LICENSE` | 上游仓库根目录 | — | 没改 |
| `VERSION` | 上游 `theme/VERSION` | — | 没改 |

`online/` 里的 `bridge.js` 是给 foobar2000 用的本地服务（网易云 / QQ 音乐），Folia 自己有 `src/services/onlineMusic/` 那一套，所以这里**不启动它、不打包它**，只是把上游代码留档，免得以后想对照时再来回翻。同样地，上游的 `theme/online/package-lock.json` 是它在自己机器上装依赖生成的锁文件，对这里没有意义，没有搬。

## 没搬的

- **`theme/assets/`（913.52 MB / 7082 个文件）**：唱片盒渲染图、壁纸、标签、开场动画、Geist Mono 字体、颗粒贴图。体积比整个仓库大两个数量级，做成运行时可选的下载，见 issue #440 与本目录的 `RHINE-ASSETS.md`。
- **`theme/screenshots/`（1.69 MB）、`theme/tools/`、`theme/update/`**：上游的预览图、`online/` 的 Windows 安装脚本和自更新清单，Folia 用不到。
- **`install.ps1` / `install.cmd` / `uninstall.*`（仓库根目录与 `theme/` 下）**：foobar2000 专用的安装程序，到 Folia 里没有对应的东西，见 `RHINE-ASSETS.md` 的「宿主层的终态约定」。

## 这个仓库自己加的（都在 `adapt/` 和根目录）

搬进来的上游文件一律没改，宿主侧需要的一切都收在下面这几个文件里：

| 文件 | 作者 | 作用 |
| --- | --- | --- |
| `index.html` | Folia | 骨架的壳：`<html data-rhine-assets>`、安全区、`adapt/` 的样式与脚本。上游没有 HTML（面板由 Columns UI 摆放），这是最短的能挂上去的一层。 |
| `host-entry.js` | Folia | 读宿主参数、听宿主的 `postMessage`、把状态收进 `window.FOLIA_RHINE`、向宿主报就绪。 |
| `adapt/rhineHostConfig.js` | Folia | `window.FOLIA_RHINE` 的形状和初值。普通脚本（非 module），必须排在所有主题脚本之前。 |
| `adapt/rhineFallback.css` | Folia | 骨架自己的皮肤，配色取 `tokens/tokens.json` 的 `AUDIO ARCHIVE` 方案。**零资源包时看到的就是它**，见下文。 |
| `favicon.svg` | Folia | 按 `theme-color` 重画的 32 px 图标（上游图标在 `assets/icons/`，属于资源包）。 |

## 降级路径为什么成立

要求是「没下载资源包时主题仍可用：缺图处降级（占位 / 纯色），不能白屏、不能报错」。

1. **骨架本身不依赖 `assets/`**：`index.html` 引用的三份文件（`rhineFallback.css`、`rhineHostConfig.js`、`host-entry.js`）都在本目录里，随仓库走，永远拿得到。
2. **颜色和字体都有不依赖资源的兜底**：`--rhine-*` 变量带浅色 / 深色两套写死在 CSS 里，字体在 `Geist Mono` 之后挂了系统等宽。
3. **「造型」只在下载后出现**：凡是来自资源包的部分（开场、唱片盒、壁纸、标签、颗粒），在 `adapt/` 里都以「底色 + 可选贴图」的形式存在，贴图缺失就是底色，不是空框。
4. **拿不到资源时主题不会去请求**：`window.FOLIA_RHINE.hasAssetsPackage` 为 `false` 时没有代码去 `fetch('assets/...')`，所以既不会有一排 404，也不会有等待超时；`<html data-rhine-assets="bundled">` 同时让 CSS 显示「还没有下载资源包」的说明。
5. **脚本出错不拖垮页面**：`host-entry.js` 和最外层壳都是普通脚本，DOM 已经在 `index.html` 里画好；即使某个脚本抛错，用户看到的仍是完整的壳，只是没有交互 —— 不会有白屏。
6. **不伪造宿主**：本目录**没有** stub `fb` / `plman` / `include()`。这几个是上游代码真正依赖的东西，假装它们存在只会让上游代码在半残状态下跑起来，问题更难查。骨架现在的定位是「代码和入口都在位」，视图正式接上去是后续几轮的事，进度记在 issue #421。

## 文件头约定

本目录里 Folia 新写的文件，文件头第一行写「改编自 RhinE」，并注明上游仓库与版本：`index.html`（第二行，HTML 注释）、`host-entry.js`、`adapt/*`、`RHINE-ASSETS.md`、`THEME-LAYERING.md`、本文件。唯一的例外是 `favicon.svg` —— 单行 SVG 放不下文件头，它的出处记在本节与 `THEME-LAYERING.md` 里。上游原文件保持原样，不改文件头：它们的出处由本节统一交代。上游原文件保持原样，不改文件头 —— 它们的出处由本节统一交代。

## 许可

MIT，全文见 `LICENSE`。上游另有一条：`theme/assets/fonts/` 里的 Geist Mono 单独按 SIL OFL 1.1 授权（`assets/fonts/OFL.txt`），与主题的 MIT 分开。那一份属于资源包，不进本仓库；真要做下载时，随包分发要一并带上它的许可证文本。
