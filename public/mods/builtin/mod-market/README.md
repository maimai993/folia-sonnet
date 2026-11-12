# 模组市场 · mod-market

给 Folia 加一个「应用内的官方模组市场」：首页导航末尾多一个整页 **模组市场**，
打开就是 <https://folium-compound.cielaniska.top> 上的全部模组，安装、更新都在这里完成——
不用再去浏览器下载、手动解压、把文件夹拖进 `mods/`。

## 它做了什么

| 动作 | 谁来做 |
| --- | --- |
| 读官方目录 `catalog.json` | 本模组的 Node 端（带 ETag + 本地缓存，断网退回上次目录） |
| 下载模组的 zip | 本模组的 Node 端，下到 `mods-cache/mod-market/packages/` |
| 核对包的 SHA-256 | 本模组的 Node 端，**哈希不符就直接丢弃，不落进 mods** |
| 解压 + 装进 `mods/` | 宿主自己的安装器（`folia-mods:install-zip`）：zip-slip 防护、体积上限、暂存校验、失败回滚都是它的 |
| 启用 | 宿主自己的 `setModEnabled`：弹的是宿主原生确认窗口，签名 / 权限 / 内容摘要由宿主核对 |
| 判断有没有新版 | 比对已装 `mod.json` 的 version 与目录里的 version |

本模组**不写** `mod-system.json`，不改任何已装模组，不绕过任何一次启用确认。

## 界面

- **列表**：官方 / 社区 / Beta / 已安装 四档过滤 + 名称、作者、说明搜索；卡片显示预览图、版本、作者、权限数、包大小与状态。
- **详情**：完整说明、逐项权限解释、实验性接口、依赖、兼容的 Folia 版本、签名密钥与签名时间、包的 SHA-256，以及「源码仓库 / 官网页面 / 直接下载 zip」。
- **更新**：有新版会在卡片与详情里标出，可单个更新，也可「全部更新」（逐个进行——宿主的安装会在结尾重载所有模组，并发会互相搅乱）。
- **命令**：命令面板里多一条「打开模组市场」；设置 → 模组 → 本模组展开后有三个开关（自动刷新 / 显示预览图 / 显示 Beta）。

## 为什么不是直接嵌官方网页

官方站返回 `content-security-policy: frame-ancestors 'none'`，浏览器层面就不允许被嵌进任何窗口，
所以市场是照着 `catalog.json` 自己画的；详情底部留了「官网页面」，可以在浏览器里打开对照。

## 权限

`filesystem.data` —— 在本模组的缓存目录里放 catalog 缓存与下载的 zip，并据此推导出
`mods/` 目录来读每个模组的版本号。网络访问只发往 `folium-compound.cielaniska.top`，
且只接受 `/downloads/` 下的包地址（防止被篡改的目录把下载指向别处）。

## 文件

```
mod-market/
├─ mod.json      清单（folium 1 / folia >=0.7.22 <0.8.0）
├─ main.cjs      catalog 拉取与缓存、下载与哈希校验、已装版本探测
├─ client.mjs    市场页面（纯 DOM，无第三方依赖）
├─ preview.png   封面
├─ LICENSE       MIT
└─ README.md
```

## 安装

把 `mod-market` 整个文件夹放进 `%APPDATA%\Folia\mods\`（或把 zip 拖进设置 → 系统 → 模组的模组面板），
重载后在模组面板里启用。启用时宿主的确认窗口会列出 `filesystem.data`，这是它唯一要的权限。

## 版本

- 1.0.1 —— 作者名与封面整理，首个对外版本。
- 1.0.0 —— 首个版本：目录浏览 / 搜索 / 过滤、一键安装（下载 + 哈希校验 + 交给宿主安装）、
  更新检测与全部更新、详情页、离线缓存。

## 许可证

MIT，见 [LICENSE](LICENSE)。无第三方依赖。
