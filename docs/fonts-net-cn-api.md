# fonts.net.cn 接入实测记录

> 这份文档记录的是**实测过的事实**，不是推测。后面写代码时以这里为准。
> 每条都标了验证方式，站点改版时先回来重跑对应的探针。

## 1. 列表

| 入口 | 路径 | 说明 |
|---|---|---|
| 中文 | `/fonts-zh-{page}.html` | 每页 10 个（实测 `li` 块 19–20，去重后 10） |
| 英文 | `/fonts-en-{page}.html` | 同上，实测 20 块 |
| 图形 | `/fonts-pic-{page}.html` | 同上 |
| 风格 / 字库标签 | `/fonts-zh/tag-{slug}-{page}.html` | 见下方"真实分类" |
| 搜索 | `/font-search-result.html?q={关键字}&page={页码}` | 结构与列表页完全一致，同一解析器可用 |

### 真实分类（照抄站点导航，不要自己编）

顶层三类：`zh`（中文）、`en`（英文）、`pic`（图形）。

风格标签（`/fonts-zh/tag-*`）：`heiti` 黑体、`songti` 宋体、`kaiti` 楷体、`xingshu` 行书、
`caoshu` 草书、`lishu` 隶书、`maobi` 毛笔、`youyuan` 幼圆、`xiangsu` 像素、`xingkai` 行楷、
`zhuanti` 篆体、`weibei` 魏碑、`shoujin` 瘦金体、`geteshi` 哥特式 等。

厂商标签：站点共 **181** 个（字魂、汉仪、方正、思源…），全塞进界面会撑爆，只挑常用的几个。

### 搜索实测

| 关键字 | 结果 |
|---|---|
| `黑体` | 10 条（方正黑体简体…） |
| `毛笔` | 10 条 |
| `round` | 10 条（LGf Besitos Round…） |
| `serif` | 10 条 |
| `思源` | 10 条 |
| 空 / 搜不到 | 0 条，页面正常返回 200 |

**搜不到不是错误** —— 页面照常返回，只是没有卡片。界面要能区分"没搜到"和"请求失败"。

## 1.5 预览：英文字体不能用中文样文

这是**最容易踩的坑**，现象是"英文分类点进去完全不显示内容"。

英文分类的列表解析本身没问题（实测 20 条，`data-font-file` 齐全），
但预览样文如果用中文，英文字体里没有汉字字形，`canvas.php` 就给回**1520 字节的空白图**：

| 字体 | 预览文字 | 返回 |
|---|---|---|
| 英文字体 HFPoet | 永风起时花落无声 | 1520 字节（空白） |
| 英文字体 HFPoet | The quick brown fox | 6355 字节 |
| 中文字体 | 永风起时花落无声 | 6412 字节 |

所以**预览文字必须按分类切换**：中文组用中文样文，英文组用英文样文。
代码里由 `categoryPreviewText()` 保证，`test/unit/fontMarket/categories.test.ts` 钉住了这条。

## 1.6 下载地址里的 JSON 转义

接口返回的 `url` 是**照 JSON 转义过的**：

```
"url":"\/\/fileres.fonts.net.cn\/font-45666-....zip?...\u0026auth_key=..."
```

`\/` 是斜杠，`\u0026` 是 `&`（签名参数靠它连着）。

用正则抓出来直接拼 `https:` 会得到一个**非法 URL**，请求必失败 ——
原生侧最终只会兜到一个笼统的 `DownloadFailed`，看不出真正原因。
必须先按 JSON 规则解转义（见 `FontArchiveDownloader.unescapeJsonString`）。

## 1.7 可下载性无法在列表页预先判定

想在小卡片上标出"这个不能下载"，实测做不到：

- `font-download` 在详情页出现次数：已停止 = 1，可下载 ≥ 2 —— 只能识别"已停止"
- 抽样 10 个验证，这套推断准确率只有 **7/10**（识别不出"需付费"，如 `FontDownloadPurchaseRequired`）

结论：不要做假标记。点下去失败后如实提示具体原因，并引导换一个。

## 2. 详情

详情页链接形如 `/font-{fontId}.html`，`fontId` 是**纯数字**（如 `41569702150`）。

验证：`node tools/probe-fonts-cn.mjs`

## 2. 下载

```
POST https://www.fonts.net.cn/api/font-download/url
Content-Type: application/x-www-form-urlencoded     ← 必须是 form，不是 JSON
X-Requested-With: XMLHttpRequest
Cookie: PHPSESSID=...                               ← 访问详情页即可拿到
Referer: https://www.fonts.net.cn/font-{fontId}.html

fontId=41569702150
```

成功返回：

```json
{ "success": true, "data": { "url": "//fileres.fonts.net.cn/font-41569-....zip?auth_key=..." } }
```

地址可能是协议相对（`//` 开头），需要补 `https:`。

**失败码**（要在界面上如实提示，不能假装成功）：

| code | 含义 | 处理 |
|---|---|---|
| `FontDownloadPurchaseRequired` | 需购买 | 引导去官网 |
| `FontDownloadLicenseRequired` | 需授权 | 引导去官网 |
| `FontDownloadDisabled` | 已停用 | 引导去官网 |
| `FontNotFound` | fontId 不对 | 视为解析错误 |

**大部分字体未登录可直接下载**（实测 36 个样本中约 70% 返回 `OK`）。

验证：`node tools/probe-fonts-cn-kinds.mjs`

## 3. 字体包结构

- `Content-Type: application/zip`，几 MB
- 内部通常是一个目录 + 一个字体文件：
  ```
  SanJiHuaChaoTi-Cu/
  SanJiHuaChaoTi-Cu-2.ttf        5084 KB，deflate 压缩
  ```
- 实测 36 个包**全部是 `.ttf`**（`magic=00010000`，sfnt 表数 17）

**但是后缀不能写死**。匹配规则按优先级取第一个命中的：

```
ttf > otf > ttc > woff2 > woff
```

跳过后缀不在白名单里的文件（`readme.txt` `license.docx` 等）。

验证：`node tools/probe-fonts-cn-unzip.mjs`（含后缀优先级测试）

## 4. 预览

详情页里有：

```html
<img data-app-image="font-preview"
     data-font-file="41569-0eb5046846c738e9eb6f95120c2ab057.ttf"
     src="//img.cdn.fonts.net.cn/cover-41569-62714-221110183817.jpg" />
```

两种预览：

### 4.1 静态封面图（列表页用，最省事）

```
https://img.cdn.fonts.net.cn/cover-{id5}-{x}-{y}.jpg
```

直接从列表页 HTML 里取 `src`，不需要额外请求。实测 6.6 KB，831x56。

### 4.2 自定义文字预览（详情页用）

```
GET https://previewer.fonts.net.cn/canvas.php?font={data-font-file}&text={文字}
```

**参数名是 `font`（值为 `data-font-file` 的完整内容），不是 `fontId`、不是 `file`、不是 `fontFile`。**
传错时服务端仍返回 200，但给的是 1520 字节的空白图 —— 这是最容易踩的坑，
用「响应体大小」或「唯一字节数」判断成没成（成功的图 > 3 KB）。

实测：`?font=41569-0eb5....ttf&text=永风起时花落无声` → 200, `image/jpeg`, 5926 字节, 831x56。

验证：`node tools/probe-canvas-preview2.mjs`

## 5. 已知限制

- 没有 JSON 列表接口，只能解析 HTML
- 少数商业字体不可下载
- `canvas.php` 传错参数会静默返回空白图，必须在界面上兜底（加载失败显示字名）
