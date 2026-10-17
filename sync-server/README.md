# Folia Sync Server

这是 Folia 的官方同步服务端实现。本服务以“多端同构”为目标设计，底层逻辑完全一致。

目前支持三种部署方案，你可以根据自己的需求任选其一：
- **Cloudflare D1 / Workers 部署 (推荐)**: 免费、免运维、高可用，依托 Cloudflare 全球边缘网络。
- **Docker 部署**: 适合有自己服务器或 VPS 的用户，一键启动，开箱即用。
- **自托管部署 (Node.js)**: 使用 SQLite，适合在本地或不方便使用 Docker 的环境运行。

## 🔐 Token 指南

无论你采用哪种部署方案，本服务都依赖以下两种 Token 进行安全验证。在开始前，请先了解它们的用途：

> [!IMPORTANT]  
> 强烈建议在部署完成后，将你生成的 Token **妥善保存在密码管理器中**。特别是对于 Cloudflare 部署，部署后的 Token 是加密状态，无法回读。

| Token | 用途 | 是否必填 | 推荐长度 | 忘记了怎么办 |
| --- | --- | --- | --- | --- |
| `SYNC_TOKEN` | 用于客户端鉴权。Folia 客户端必须拥有此 Token 才能读取和覆盖同步数据。 | **必填** | 8 ~ 32 位随机字符 | 重新生成并覆盖环境变量 |
| `DASHBOARD_TOKEN` | 用于在浏览器中查看服务状态和数据库统计（防扫描的隐藏看板）。 | 选填 | 16 位以上的随机字符 | 重新生成并覆盖环境变量 |

### 如何生成高强度 Token？

你可以使用以下任意一种快速生成的方式：

**方法 1：浏览器控制台 (最简单)**
按 `F12` 打开浏览器控制台 (Console)，输入并运行：
```javascript
crypto.randomUUID()
```

**方法 2：Node.js 终端**
在终端中运行：
```bash
node -e "console.log(crypto.randomBytes(16).toString('hex'))"
```

**方法 3：OpenSSL (Linux/macOS 终端)**
在终端中运行：
```bash
openssl rand -hex 16
```

> [!WARNING]  
> 为防止被扫描器字典爆破，服务端**强制要求 `SYNC_TOKEN` 的长度必须大于等于 8 位**，否则服务将拒绝启动（或持续报错）。
> 对于暴露在公网的服务，强烈建议在边缘层（如 Cloudflare WAF 或 Nginx）配置 **Rate Limiting (频率限制)** 防范高频猜测攻击。

---

## 方案一：Cloudflare Workers 部署 (推荐)

零成本、免服务器的 Serverless 部署。当前仓库已经提供安装脚本，可以自动完成 D1 创建、`wrangler.local.toml` 生成、Secret 注入和最终部署，推荐优先使用脚本。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maimai993/folia-sonnet/tree/main/sync-server)

> [!WARNING]
> 一键部署按钮可能无法自动完成 D1 数据库的绑定与 Token 注入。如果使用一键部署按钮，你需要**在部署后**前往 Cloudflare 控制台手动创建 D1 数据库、重新配置绑定变量，并设置 `SYNC_TOKEN` 环境变量。因此，**更推荐使用下方的安装脚本**。

### 前置要求
- 注册 Cloudflare 账号
- 本机可用 Node.js 24 或更高版本以及 `npm`

### 1. 运行安装脚本

进入 `sync-server` 目录后，根据你的系统执行：

```bash
cd sync-server
```

Linux / macOS / WSL / Git Bash:

```bash
bash ./install.sh
```

Windows PowerShell / PowerShell 7:

```powershell
.\install.ps1
```

如果遇到执行策略拦截，可以改用：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本启动后都会显示部署菜单：

```text
1) Node (PM2)
2) Docker
3) Cloudflare Workers
```

输入 `3`，进入 Workers 部署流程。

### 2. 按提示完成 Cloudflare 部署

脚本会自动执行以下步骤：

- 安装项目依赖
- 调用 `npx wrangler d1 create folia-sync -c wrangler.toml` 创建 D1 数据库
- 如果数据库已存在，则自动查询已有数据库 ID
- 基于 `wrangler.toml` 生成 `wrangler.local.toml`
- 将真实的 `database_id` 写入 `wrangler.local.toml`
- 提示你输入 `SYNC_TOKEN`
- 自动生成 `DASHBOARD_TOKEN`
- 通过 `wrangler secret put` 将两个 Token 注入 Cloudflare
- 执行 `npm run deploy:cf -- --config wrangler.local.toml` 完成发布

> [!NOTE]
> 首次运行时，Wrangler 可能会要求你在浏览器中登录 Cloudflare 并授权，这是正常现象。

### 3. 保存部署结果

脚本部署完成后会输出：

- Worker 的访问域名
- 自动生成的 `DASHBOARD_TOKEN`
- 看板访问链接格式 `https://<你的Worker域名>/?token=<DASHBOARD_TOKEN>`

其中 `DASHBOARD_TOKEN` 只会在部署时明文显示一次，务必立即保存。

### 4. 脚本生成的本地文件

脚本会在当前目录生成 `wrangler.local.toml`，用于保存当前环境对应的 D1 配置。

- 这个文件已经被 `.gitignore` 忽略
- 不要把它提交到仓库
- 如果你后续需要重新部署，可以继续复用这个文件

### 手动部署说明

如果你不想使用安装脚本，也可以按下面的步骤手动部署。

#### 1. 安装依赖并登录 Cloudflare

```bash
cd sync-server
npm install
npx wrangler login
```

首次登录时，Wrangler 会拉起浏览器完成授权。

#### 2. 创建 D1 数据库

```bash
npx wrangler d1 create folia-sync -c wrangler.toml
```

命令成功后，记下输出中的 `database_id`。

如果你已经创建过同名数据库，可以改用下面的命令查看列表：

```bash
npx wrangler d1 list
```

#### 3. 生成本地部署配置

复制模板文件：

```bash
cp wrangler.toml wrangler.local.toml
```

然后打开 `wrangler.local.toml`，把下面这一项：

```toml
database_id = "replace-with-your-d1-database-id"
```

替换成你刚才拿到的真实 `database_id`。

#### 4. 注入 Cloudflare Secrets

先准备两个 Token：

- `SYNC_TOKEN`：必填，至少 8 位
- `DASHBOARD_TOKEN`：建议自行生成一个 16 位以上随机字符串

然后执行：

```bash
npx wrangler secret put SYNC_TOKEN --config wrangler.local.toml
npx wrangler secret put DASHBOARD_TOKEN --config wrangler.local.toml
```

命令执行后，终端会提示你分别输入对应的 Token 值。

#### 5. 部署到 Workers

```bash
npm run deploy:cf -- --config wrangler.local.toml
```

部署成功后，Wrangler 会输出你的 Worker 域名。此时可以使用下面的格式访问隐藏看板：

```text
https://<你的Worker域名>/?token=<DASHBOARD_TOKEN>
```

#### 6. 后续更新部署

如果只是更新代码，通常不需要重新创建 D1，也不需要重新设置 Secret，直接重新执行：

```bash
npm run deploy:cf -- --config wrangler.local.toml
```

---

## 方案二：Docker 部署

Docker 资产已统一迁移到仓库的 `deploy/docker` 目录。完整 Web 堆栈与 HTTPS 说明见 [`deploy/docker/README.md`](../deploy/docker/README.md)；这里只保留 Sync Server 单独构建方式。

### 1. 准备配置

进入 Sync Server 目录并创建 `.env`：

```bash
cd sync-server
touch .env
```

在同级目录下新建 `.env` 文件，配置 Token：

```env
# 必填：客户端鉴权 Token (至少 8 位)
SYNC_TOKEN="你的_SYNC_TOKEN"

# 选填：网页看板访问 Token (至少 16 位)
DASHBOARD_TOKEN="你的_DASHBOARD_TOKEN"

# 选填：可视化面板 /admin 的登录凭据（不填就用出厂那一组，两个都要给才生效）
ADMIN_USERNAME="你的账号"
ADMIN_PASSWORD="你的密码"
```

### 2. 从仓库根目录启动服务

```bash
cd ..
docker compose -f deploy/docker/compose.sync.yaml up -d --build
```
启动后，服务监听容器内的 `3000` 端口，并映射到宿主机的 `13000` 端口；数据库文件持久化在 `sync-server/data/folia-sync.db`。

---

## 方案三：Node.js 自托管部署

使用 Node.js 运行，底层使用 `better-sqlite3`。

### 前置要求
- Node.js >= 24（与根项目和 `sync-server/package.json` 的 engine 一致）
- npm / pnpm

### 1. 配置环境变量

在 `sync-server` 目录下创建一个 `.env` 文件，填入你的 Token 和配置：

```env
# 必填：客户端同步密钥（最少 8 位）
SYNC_TOKEN="你的_SYNC_TOKEN"

# 选填：网页看板的访问密钥
DASHBOARD_TOKEN="你的_DASHBOARD_TOKEN"

# 选填：服务运行端口（默认 3000）
PORT=3000

# 选填：SQLite 数据库保存路径（默认在当前目录生成 folia-sync.db）
DB_PATH="./folia-sync.db"

# 选填：可视化面板 /admin 的登录凭据（不填就用出厂那一组，两个都要给才生效）
ADMIN_USERNAME="你的账号"
ADMIN_PASSWORD="你的密码"
```

### 2. 安装并启动

```bash
cd sync-server
npm install
npm run start:node
```

你可以使用 PM2 或 Docker 来进行持久化管理。

---

## 客户端接入与 API

Folia 客户端的“存储设置”使用 `workerBaseUrl` 和 `SYNC_TOKEN` 连接服务端。地址填写服务根地址，例如：

```text
https://folia-sync.example.workers.dev
http://127.0.0.1:13000
```

`SYNC_TOKEN` 通过 `Authorization: Bearer <SYNC_TOKEN>` 发送。除 `GET /health`、字体市场和云缓存这三个公开只读/共享接口外，API 均需要鉴权；根路径 `/?token=<DASHBOARD_TOKEN>` 是只读网页看板，不是客户端 API。

当前 API：

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 连通性和 schema 版本检查 |
| `GET` | `/state` | Bearer | 读取设置/主题更新时间和主题数量 |
| `GET` / `PUT` | `/settings` | Bearer | 读取或按时间戳更新视觉设置快照 |
| `GET` | `/themes/manifest` | Bearer | 读取 256 个主题 bucket 摘要 |
| `POST` | `/themes/get` | Bearer | 按稳定 fingerprint 读取主题 |
| `POST` | `/themes/put` | Bearer | 批量写入主题，旧时间戳不会覆盖新记录 |
| `POST` | `/themes/bucket` | Bearer | 按 bucket 拉取主题，用于增量同步 |
| `POST` | `/themes/list` | Bearer | 分页读取完整主题库，用于导出 |
| `GET` | `/api/fonts` | 无 | 字体市场目录（只回已启用的，含后台烤好的预览图地址） |
| `GET` | `/api/fonts/:id/file` | 无 | 下载字体文件本体（客户端点「使用」才取） |
| `GET` | `/api/fonts/:id/preview` | 无 | 预览图（不可变缓存） |
| `GET` / `PUT` | `/api/ai-stage?title=&artists=` / `/api/ai-stage` | 无 | 完整歌名与 JSON 艺人数组身份的通用视觉方案；普通 PUT 原子补缺并返回现存版本，GET 支持 ETag / If-None-Match |
| `PUT` | `/api/ai-stage/replace` | Bearer | 显式替换通用版，必须提供当前 `baseRevision`，旧修订返回 409 |
| `GET` | `/api/ai-stage/history?title=&artists=` | Bearer | 最近最多十份旧版；恢复时将旧 payload 与当前 baseRevision 提交 replace |
| `GET` | `/api/ai-cache/:kind/:key` | 无 | 保留旧歌词与 policy MD5 键读取能力 |
| `PUT` | `/api/ai-cache/:kind/:key` | 无 | 兼容旧键补缺，不覆盖现存条目；stage 必须完整合法，UTF-8 payload 上限 64KB |
| `GET` | `/admin/api/ai-cache-backups/:kind/:key` | 登录 | 这个键被覆盖前留下来的旧版（最多 10 份，新的在前） |
| `POST` | `/admin/api/ai-cache-backups/:id/restore` | 登录 | 把某一版旧版捞回成当前那条（当前那条会先存进备份，捞错还能再捞） |
| `GET` | `/stage` | 无 | 访客检索页：按歌名搜云缓存（支持 `?q=`） |
| `GET` | `/stage/entry/:key` | 无 | 访客详情页：这一条用了什么动画模式、什么配色、哪些高亮词 |
| `GET` | `/api/stage-gallery/search?q=&limit=` | 无 | 检索页输入即搜用的接口，回 JSON 与服务端渲染好的结果片段 |

字体市场与云缓存的接口刻意放在 Bearer 门之外：没有填 key 的用户也要能先拉到别人已经生成好的结果。同步数据（设置 / 主题）依旧受 `SYNC_TOKEN` 保护。

通用缓存采用完整 title 与结构化 artists 的有限规范化身份，不拆分艺人、不去除 Live 等版本文字，缺艺人返回 400。GET 的 provider/mediaId 仅作可选来源信息，不参与匹配；PUT JSON 为 `{title, artists, provider?, mediaId?, payload, baseRevision?}`。响应顶层包含 `hit`、`identityKey`、`revision`、`payload`，未命中为 200 `hit:false`；普通 PUT 的 `stored:false` 表示返回已有公共版。修订使用唯一 ID，相同内容重试不建新版；恢复发布生成新修订，防止旧授权在恢复后复活。新表与触发器通过 CREATE IF NOT EXISTS 添加，不改变同步 schema 对外版本。

`ai_stage_sources` 保存每身份最多64条客户端自报的 `(provider, mediaId)` 多对多关联，仅在合法 PUT 后登记；标记为 `client_reported`，不是核验结果，GET 不凭该关联绕过歌名与艺人身份。公开写入有每进程/Worker isolate、每连接IP每分钟120次的基础限制，桶最多1024个；Node 读取连接地址，Cloudflare 请求读取平台提供的IP，无可信地址时共享匿名桶。反向代理可能使用户共用桶，多实例也不共享计数，公网仍应配置边缘限流。

可选只读迁移预演：编译后使用 Node24 执行 `node sync-server/dist/stageMigrationPreview.js <本地SQLite路径> <元数据JSONL路径>`。JSONL 每行显式提供 `{key,title,artists,payload}`；只有结构化身份完整、现存旧键存在且归档内容与当前数据库一致、payload 完整合法的项才列为候选。同身份内容冲突单独报告且不列候选。程序以 readOnly 打开数据库，不联网、不写入；不从同名推断艺人，也不把候选列表视为迁移完成。

新接口不请求音乐平台、不检查歌词哈希或时间轴；完整 light/dark 四个颜色字段、已注册模式与允许参数严格验证，参数定义由 `shared/stageCatalog.mjs` 与客户端共用。replace/history 使用 SYNC_TOKEN，请仅由受控管理流程调用。该接口是可选扩展，旧 APK 不会自动使用；不包含已部署或真实数据迁移的承诺。客户端行为与验收边界见 [AI视觉缓存说明](../docs/ai-stage-cache.md)。

字体文件**只能由后台管理人员上传**，上传时在管理员浏览器里用 canvas 把预览图烤成 PNG 一并存库，所以客户端列目录时只需要几 KB 的预览图，几 MB 的字体本体只有点「使用」那一刻才会下载。

主题同步 registry、同步下载或导入的主题记录可以保存在本机 IndexedDB，启动时会自动做主题同步；视觉设置的拉取/推送、完整 sync library 的 zip 导入导出由存储设置页面或命令面板触发。主题 registry 从旧 localStorage 迁移到 IndexedDB 时会执行一次性兼容迁移。当前云缓存 `stage` 的复用主要依赖短期内存，普通播放恢复也未接入按歌读取这些同步记录；不能将同步下载等同于完整视觉方案已经可按歌离线使用。

服务端实现位于 `src/app.ts`，Node 入口位于 `src/node.ts`，Cloudflare 入口位于 `src/cloudflare.ts`；`src/d1-emulator.ts` 为 Node 环境提供 D1 兼容实现。三种部署方式共用同一套路由和 D1/SQLite 兼容的数据访问模型。Cloudflare 配置模板是 `wrangler.toml`，安装脚本生成的 `wrangler.local.toml` 不应提交。

实现定位：

- `src/app.ts`：Hono 路由、Bearer/dashboard 鉴权、schema 版本、设置和主题同步 API。
- `src/node.ts`：Node server 与 SQLite 启动入口。
- `src/cloudflare.ts`：Worker/D1 适配入口。
- `src/d1-emulator.ts`：本地 Node 对 D1 风格存储的兼容层。
- `src/admin.ts`：可视化面板的登录门（数据库 session + httpOnly cookie）。
- `src/panel.ts`：可视化面板页面（字体市场上架、云缓存查看与清理）。
- `src/fonts.ts`：字体市场的公开目录接口与管理员上传 / 启停 / 删除接口。
- `src/aiCache.ts`：AI 生成缓存的公开读写接口与管理员管理接口（含覆盖前的备份与回滚）。
- `src/stageVerifier.ts`：一条上传收不收 —— 空数据、形状合规、以及拿平台歌词重算哈希。
- `src/stageLyricSources.ts`：从各音乐平台把歌词原文件取回来（只用于算哈希，不落库）。
- `src/md5.ts`：MD5 实现（WebCrypto 不提供 MD5，而缓存键就是它）。
- `src/stageGallery.ts` / `src/stageGalleryView.ts`：对外那一面（访客检索页与详情页）的路由与渲染。
- `install.sh` / `install.ps1`：Node、Docker、Cloudflare 三种部署菜单。

当前协议约束：schema version 为 `2`（v2 新增 `font_market` / `font_files` / `font_previews` / `ai_cache` / `admin_sessions` 五张表），主题 manifest 固定为 `256` 个 bucket；主题批量写入上限为 `500`，bucket 请求最多 `32` 个，完整主题 list 最多 `1000` 条；字体文件单份上限 `40MB`、预览图 `2MB`；AI 缓存单条 payload 上限 `64KB`，`kind` 需匹配 `^[a-z0-9_-]{1,32}$`、`key` 需匹配 `^[a-f0-9]{32}$`。修改这些限制或路由时必须同步客户端 `src/services/sync/*`、`src/services/fontMarket.ts`、`src/services/aiCloudCache.ts` 和本 README。

---

## 🖥 网页看板与跨端配置

如果你在部署时配置了 `DASHBOARD_TOKEN`，你可以通过浏览器访问隐藏看板：

**访问地址**: `http://你的服务域名/?token=你的_DASHBOARD_TOKEN`

如果 Token 正确，你将看到一个极简的状态看板，展示当前数据库中存储的主题数量和最近更新时间。此页面仅作信息展示，无任何敏感交互。

---

## 🎛 可视化管理面板

服务自带一个带登录的可视化面板，用来上架字体、查看和清理 AI 云缓存。

**访问地址**：`http://你的服务域名/admin`

**出厂账号密码**：

| 项目 | 默认值 |
| --- | --- |
| 账号 | `maimai993` |
| 密码 | `IgFXYJPHtEB9eog6TqYRhjk6` |

> [!WARNING]
> 这是**写在源码里的出厂凭据**，仓库公开 = 谁都看得到。它只保证「服务起得来就能登进去」，
> **部署到公网前必须换成自己的**：
>
> ```env
> ADMIN_USERNAME="你的账号"
> ADMIN_PASSWORD="你的密码"
> ```
>
> 环境变量一旦只配了一个（比如只配了账号），另一项仍会回落到出厂值，等于没换 ——
> 两个都要给。还在用出厂值时，启动日志会打一条黄色警告，登录后的面板顶部也会挂一条提醒。
>
> 登录态存在服务端的 `admin_sessions` 表里，浏览器只持有一个 httpOnly cookie，有效期 12 小时，
> 剩余不足 10 小时且仍在活跃使用时自动续期；退出登录即从库中删除该条 session。

面板有两个页签：

- **字体市场**：上传字体文件（`.ttf` / `.otf` / `.woff` / `.woff2`，≤ 40MB），上传时会自动用 `FontFace` + canvas 烤出一张预览图；已上架的字体可以改名、改分类、启用 / 停用、删除。停用的字体不会出现在客户端目录里。
- **云缓存**：按 `theme` / `director` 筛选，支持按 MD5 或歌名搜索，可以查看某条缓存的完整 payload、删除单条或按类型清空。

面板的写操作接口都在 `/admin/api/*` 下，受上面那套 session + `requireAdmin` 中间件保护；只读的 `/api/fonts` 与 `/api/ai-cache` 仍然公开。

---

## 🛡 上传校验与覆盖备份

上传接口是公开的（没填 Key 的人也要能把自己那份推上来），所以「有人拿空数据把别人做好的那条盖掉」迟早会发生。两道防线：

**一、收不收：先过校验**

| 情况 | 处置 |
| --- | --- |
| 空数据（既没有主题也没有动画决策） | **一律拒绝**（400 `empty_payload`） |
| 形状不合规 / 超过 64KB | 拒绝（400 `invalid_payload`） |
| 纯音乐：哈希与歌名对不上 | 拒绝（400 `lyric_mismatch`） |
| 搜索结果里**任一首**的歌词哈希一致 | 收下，记 `verified` |
| 哈希都不一致，但 AI 标记的高亮词在这首歌的歌词里**都在** | 收下，记 `word_matched` |
| 哈希都不一致，且高亮词找不齐（或压根没有高亮词） | 拒绝（400 `lyric_mismatch`） |
| 平台搜不到这首歌 / 接口不通 | **放行**，记 `unverified` |
| 旧客户端没带歌词哈希 | 放行，记 `unverified` |

**比对不是只比搜索结果第一条**：同一首歌在平台上有好几个版本（翻唱、现场、别人重新传的 LRC），上传者手里那份未必是第一条 —— 只比一条会把大量正常上传误判成「不一致」。所以按歌名搜索后**最多取前三首**逐个比，命中就停（后面几首的歌词一次都不拉）。

**哈希对不上还有一道「内容合规」**：换了个版本的 LRC 哈希就变了，可答案照样是照着这首歌做的。这一条按内容判 —— 答案里 **AI 标记的高亮词（`theme.light/dark.wordColors`）在这首歌的歌词里全都找得到**就算合规（比的时候忽略空白与大小写）。一个高亮词都没有时不算合规：哈希已经对不上了，再没有任何证据说明它属于这首歌。

**放行那条是纪律**：第三方平台接口随时会抖，缓存的底线是永不阻塞功能 —— 一次上游抖动不该变成全站上传失败。真要临时关掉这道校验（只留空数据与合规那两道），设 `AI_CACHE_VERIFY=off`。

**二、盖掉了也能捞回来：覆盖前留旧版**

每次覆盖之前，旧的那版整条存进 `ai_cache_backups`，**每个键最多 10 份**（超了删最旧的）。管理员在 `/admin/api/ai-cache-backups/:kind/:key` 能翻旧版，挑一版 `POST /:id/restore` 捞回来 —— 捞的时候当前那条也会先存进备份，捞错还能再捞。

**关于平台名字段**

上传现在多带三个字段：`platform`（netease / qq / kugou，本地歌曲留空）、`lyricHash`（歌词正文的 MD5）、`isPureMusic`。

- **拉取那条链路完全不看它们**，键仍然是那个 MD5 —— 早先推上去、没有这些字段的条目照样拉得到。
- `lyricHash` 之所以要单独带一份：缓存键是「歌词 + policy」的 MD5，而 policy 里的屏蔽样式与自定义提示词只有本机能算，服务端复现不出来，所以另给一份纯歌词的哈希去比对。
- 没写平台名（本地歌曲、旧客户端）时，服务端按 **netease → qq → kugou** 顺序逐个平台试，先搜到谁算谁。

## 🔍 访客检索页

云缓存里躺着别人已经生成好的那一份，这一面把它开放给**所有人看，不用登录**：

**访问地址**：`http://你的服务域名/stage`

按歌名搜索，点进 `http://你的服务域名/stage/entry/<md5>` 看这一条的细节：

- **动画模式**：AI 给这首歌定的是哪个歌词动画（中文名 + 模式 ID + 一句话性格），以及它给出的理由与参数；
- **主题颜色**：浅色 / 深色两套配色，色块直接用取到的颜色铺底，并标出主色、强调色、次色的 hex；
- **高亮词**：AI 标出的那几个词，用**它自己给的那个颜色**显示。

几点说明：

- 缓存的键是**歌词文件的 MD5**，歌名是推送时顺手记在 `song_title` 列上的 —— 所以检索只走这一列，没记歌名的条目搜不到（详情页按 MD5 仍可直达）。空查询时展示最近更新、且记得住歌名的那些。
- 这一面**只读**，且刻意挂在 `app.route('/', api)` 那张 Bearer 兜底网之前 —— 挂到后面访客就都进不来了。
- 页面上每一个字都来自任何人都能 PUT 的 payload：文本一律转义，颜色只认 `#rgb` / `#rrggbb`，认不出的换成兜底色。颜色尤其要卡死 —— 它们会被拼进 `style="..."`，放过一个 `;` 就是一处注入。
- 结果片段由服务端渲染好后经 `/api/stage-gallery/search` 回传，转义只在服务端做一遍，前端不重复实现渲染。
