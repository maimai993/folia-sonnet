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

# 选填：显式启用 /admin；两项必填，密码去掉两端空白后至少 16 字符，否则面板关闭
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

# 选填：显式启用 /admin；两项必填，密码去掉两端空白后至少 16 字符，否则面板关闭
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

### 3. 并发一上来就卡？先看这一段

Node 版用的是 `better-sqlite3`，它是**同步**驱动：一条 SQL 跑多久，这个进程的事件循环就被占住多久，所以「并发一多就卡」通常是**所有请求在一个线程里排队**，不是连接数不够。好消息是多核默认就吃满了，一般不用配。

**进程数（默认自动）**

服务启动时会自动按 CPU 核数开进程：核数减一（给系统留一个核），封顶 4 个。单核机器自动保持单进程。启动日志里会写明：

```
- Processes: 4 个进程
[worker 1] 已启动：端口 3000，数据库 /app/data/folia-sync.db
...
```

想手动指定就在 `.env` 里写（`0` = 单进程，保留旧行为）：

```env
# 选填：进程数。不填 = 自动（核数 - 1，最多 4）；0 = 单进程
SYNC_SERVER_CLUSTER_WORKERS=4
```

要点：

- **别超过 CPU 核数**，多了只增加内存占用不会更快。每个进程各有一份 SQLite 页缓存（64MB）和 JS 堆，内存紧张的 VPS 建议显式写小一点。
- 多个进程共享同一个数据库文件（WAL 模式，各自一个连接，写操作靠 `busy_timeout` 互相等待）。读请求（绝大多数流量）完全并行；写多的场景进程间会有短暂锁竞争。
- 每小时一次的历史清理只让 0 号进程做，不会重复。
- 某个 worker 崩了会自动补一个，不用手动重启。
- Docker 部署改动后要 `docker compose ... up -d --force-recreate`（`restart` 不会重读环境变量）。

**如果开了多进程还是慢**

瓶颈就落在 SQL 上了，按这个顺序查：

1. **确认索引在。** 索引由服务首次请求时自动建（`CREATE INDEX IF NOT EXISTS`），老库升级后**重启一次**就会补上，不用手动迁移；库很大时首次启动会慢一次。
2. **看慢在哪个接口。** 按精确键取（`GET /api/ai-cache/:kind/:key`）走主键索引，是 0.3ms 量级；`POST /api/ai-cache/resolve` 的 `LIKE '%歌名%'` 走不了索引，**它天然随库大小变慢**，加进程只能摊薄。要让 resolve 也做到与库大小无关，得在 `song_title` 上另存拆好的词表、用倒排索引替代 LIKE —— 那是换结构。
3. **加一层反向代理与限流。** `/api/ai-cache/*` 是**公开**的（没填 Key 的人也要能读），不限流的话一台脚本就能把并发打满。

> 实测（4 万条缓存、每条 6KB、32 并发，真实 `dist/node.js`）：
>
> | 场景 | 1 个进程 | 4 个进程 |
> | --- | --- | --- |
> | 命中 `GET` | 725 req/s，p50 31.8ms | 687 req/s，p50 5.4ms |
> | `POST resolve` | 107 req/s，p50 295ms | **272 req/s，p50 69ms** |
> | `GET /songs` | 165 req/s，p50 188ms | **443 req/s，p50 39ms** |
> | 混合负载 | 303 req/s，p50 102ms | **551 req/s，p50 34ms** |
>
> 优化前同一套数据下单进程是 resolve 17 req/s（p50 1877ms）、/songs 14 req/s（p50 2166ms）。

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
| `GET` / `PUT` | `/settings` | Bearer | 读取视觉设置；旧客户端按时间戳写，新客户端按 revision CAS 写 |
| `GET` | `/settings/confirmation` | Bearer | 读取 `settings-cas-v1` 快照与 opaque revision（禁止缓存） |
| `GET` | `/themes/manifest` | Bearer | 读取 256 个主题 bucket 摘要 |
| `POST` | `/themes/get` | Bearer | 按稳定 fingerprint 读取主题 |
| `POST` | `/themes/put` | Bearer | 批量写入主题，旧时间戳不会覆盖新记录 |
| `POST` | `/themes/bucket` | Bearer | 按 bucket 拉取主题，用于增量同步 |
| `POST` | `/themes/list` | Bearer | 分页读取完整主题库，用于导出 |
| `GET` | `/api/fonts` | 无 | 字体市场目录（只回已启用的，含后台烤好的预览图地址） |
| `GET` | `/api/fonts/:id/file` | 无 | 下载字体文件本体（客户端点「使用」才取） |
| `GET` | `/api/fonts/:id/preview` | 无 | 预览图（不可变缓存） |
| `GET` | `/api/ai-cache/:kind/:key` | 无 | 拉取 AI 生成缓存，`kind` 为 `theme` / `director`，`key` 为歌词文件 MD5 |
| `PUT` | `/api/ai-cache/:kind/:key` | 无 | 上传 AI 生成结果（单条 payload 上限 64KB，空数据与不合规的一律拒绝） |
| `GET` | `/admin/api/ai-cache-backups/:kind/:key` | 登录 | 这个键被覆盖前留下来的旧版（最多 10 份，新的在前） |
| `POST` | `/admin/api/ai-cache-backups/:id/restore` | 登录 | 把某一版旧版捞回成当前那条（当前那条会先存进备份，捞错还能再捞） |
| `GET` | `/stage` | 无 | 访客检索页：按歌名搜云缓存（支持 `?q=`） |
| `GET` | `/stage/entry/:key` | 无 | 访客详情页：这一条用了什么动画模式、什么配色、哪些高亮词 |
| `GET` | `/api/stage-gallery/search?q=&limit=` | 无 | 检索页输入即搜用的接口，回 JSON 与服务端渲染好的结果片段 |

字体市场与云缓存的接口刻意放在 Bearer 门之外：没有填 key 的用户也要能先拉到别人已经生成好的结果。同步数据（设置 / 主题）依旧受 `SYNC_TOKEN` 保护。

字体文件**只能由后台管理人员上传**，上传时在管理员浏览器里用 canvas 把预览图烤成 PNG 一并存库，所以客户端列目录时只需要几 KB 的预览图，几 MB 的字体本体只有点「使用」那一刻才会下载。

客户端是本地优先的：AI 主题和主题同步 registry 保存在本机 IndexedDB，启动时会自动做主题同步；视觉设置的拉取/推送、完整 sync library 的 zip 导入导出由存储设置页面或命令面板触发。主题 registry 从旧 localStorage 迁移到 IndexedDB 时会执行一次性兼容迁移。

视觉设置确认协议（增量扩展，不降低 `/health`、`/state`、manifest 的 wire version **2**）：

- `/settings/confirmation` 返回 `{ protocol: 'settings-cas-v1', revision, record }`；空库两者为 `null`。revision 为现有行完整 JSON 和时间戳的 SHA-256，不是客户端时钟；同 timestamp 不同内容也会改变 revision。
- 新客户端向 `PUT /settings` 的原有 record 添加 `expectedRevision`（空库为 `null`）。服务端比较 revision，并以单条 SQLite/D1 `UPDATE ... WHERE value_json = ? AND updated_at = ? RETURNING ...` 或空库 `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` 确认实际写入；竞争返回 **409**，不自动覆盖重试。成功返回 `accepted: true`、本次完整 record、revision；客户端检查 payload 后才保存同步基准。服务端为兼容旧读者生成单调 `updatedAt`，正确性不依赖设备时钟。
- 无数据库迁移、无新列；要求宿主 SQLite/D1 支持 `RETURNING`。旧客户端不带 `expectedRevision` 时保持原时间戳 LWW 行为和 `{ok:true}` 响应（包括旧请求可能 no-op 的历史行为）；其局限并未被新协议追溯修复；旧 LWW writer 在 CAS 成功之后仍可按它的时间戳覆盖新记录，混用期间不能保证所有客户端都遵守冲突决议。settings payload 接受 **1 / 2**，修复此前客户端导出1、服务端要求2的既有不一致；客户端读 parser 接受两者，导出仍保留1以兼容既有文件。
- **先升级服务端，再升级客户端**。新客户端连接没有 confirmation 端点的旧服务端会明确失败，不退回盲写/盲 ACK；主题同步仍可单独使用。首次没有已确认基准时保守提示冲突，不用旧 timestamp 猜测本地是否改过；显式保留本地也受 CAS 保护。冲突窗口打开后云端又变更，需要重新选择。
- 本地仅导入或导入推送失败都保留 dirty 状态；不会把备份文件日期当作云端同步证据。推送期间的本地编辑不会被记为已同步。基准按 `[enabled, URL, token]` 的 SHA-256 隔离（不存明文 token）；切换 URL/凭据后需要建立新基准，旧冲突选择也不能跨配置复用。此修复不包含旧服务端 schema 初始化/batch 的事务缺陷，部署时建议同时合入独立的 P06 修复；本协议的 CAS 写入本身只用单条 SQL，不依赖 batch。

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
- `scripts/scan-dirty-cache.mts`：扫云缓存里「内容与键对不上」的脏条目（只读，见下）。

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

**默认关闭，没有内置账号或密码。** Node 环境变量或 Workers secrets 必须同时配置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`；用户名不能为空，密码去掉两端空白后至少 16 字符（实际验证密码仍保留空白）。缺失、空值或不足门槛时，所有 `/admin` 页面/API 返回 `503 admin_not_configured`，同步与公开缓存/字体接口不受此门槛影响。示例密码只是占位，部署时请使用随机长密码。

```env
ADMIN_USERNAME="你的账号"
ADMIN_PASSWORD="请换成至少16字符的随机长密码"
```

升级时自动给 `admin_sessions` 增加可空 `credential_tag` 列，不删除现有数据，也不改变对外 schema version 2。旧版没有标签的 session 无法继续登录，用户需要重新登录。轮换用户名或密码也会使旧 session 失效。先备份数据库再升级，Node 与 Workers 都要更新实际生效的环境配置；多副本需要同步轮换配置并滚动更新，尚未更新的旧进程仍按旧配置运行。

浏览器只持有 HttpOnly、SameSite=Lax cookie，HTTPS 时带 Secure；有效期 12 小时，剩余不足 10 小时且访问面板时续期；退出删除 session。所有管理响应 `Cache-Control: no-store`，不提供跨源 CORS，写操作拒绝不同 Origin 或 cross-site Fetch Metadata。无 Origin 的非浏览器管理脚本仍需正常登录 cookie。

> [!WARNING]
> 公网部署必须使用 HTTPS，并在反向代理/WAF 配置登录限流与访问控制。16 字符门槛不是密码强度检测，本服务没有分布式抗暴力破解保证。HTTPS 反向代理转发到 HTTP Node 时，显式配置 `ADMIN_PUBLIC_ORIGIN="https://你的公开服务域名"`（只允许 HTTP(S) origin，无路径/账号/查询参数），使同源校验与 Secure cookie 使用公开地址。未配置则使用收到请求的 origin；格式错误会关闭管理入口。服务不信任客户端提供的 X-Forwarded-* 头来决定授权 origin。Workers 可在 vars 中配置同名值。

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

归档、裁剪旧备份、替换当前值在同一个 D1/SQLite batch 中执行；恢复时读取并删除所选备份也在同一批次中，裁剪不会提前删除所选版本。备份若已被另一次恢复消费或删除，返回 `404 not_found`，不再写入当前值或备份。任一步失败都会回滚整批，不会吞掉备份错误后继续覆盖。单条 payload 的 `64KB` 上限按 JSON 序列化后的 UTF-8 字节数（`65536` bytes）计算，`payloadBytes` 返回同一字节数，不按 JavaScript 字符串长度计数。

**关于平台名字段**

上传现在多带三个字段：`platform`（netease / qq / kugou，本地歌曲留空）、`lyricHash`（歌词正文的 MD5）、`isPureMusic`。

- **拉取那条链路完全不看它们**，键仍然是那个 MD5 —— 早先推上去、没有这些字段的条目照样拉得到。
- `lyricHash` 之所以要单独带一份：缓存键是「歌词 + policy」的 MD5，而 policy 里的屏蔽样式与自定义提示词只有本机能算，服务端复现不出来，所以另给一份纯歌词的哈希去比对。
- 没写平台名（本地歌曲、旧客户端）时，服务端按 **netease → qq → kugou** 顺序逐个平台试，先搜到谁算谁。

---

## 🧹 扫云缓存里的脏条目

判定收紧之前，拉缓存是「精确键没中 → 按歌名挑一条 → **回填到自己的键上**」。回填之后每次都是精确命中，于是**错一次就一直错下去**：键是这首的，内容是别首的。新条目不会再脏，可早先写进去的那些还躺着。

`scripts/scan-dirty-cache.mts` 就是去把它们点出来：

```bash
cd sync-server
npx tsx scripts/scan-dirty-cache.mts                 # 全量只读扫一遍
npx tsx scripts/scan-dirty-cache.mts --only 晴天      # 只看某个歌名
npx tsx scripts/scan-dirty-cache.mts --limit 40 --out /tmp/dirty.json
```

判据跟客户端拉缓存那一侧是**同一条规矩**：AI 标的高亮词里能当证据的那几个（去掉单字与虚词），在这首歌的歌词里必须 **100%** 全在。歌词由服务端那套歌词源去平台上搜，最多取 3 个版本 —— 同一首歌换个版本的 LRC 照样算数。

| 结论 | 含义 | 怎么办 |
| --- | --- | --- |
| `dirty` | 高亮词在这首歌的歌词里凑不齐 —— 键与内容对不上 | 删掉，或让客户端重新生成覆盖 |
| `clean` | 证据词全在 | 留着 |
| `no_evidence` | 这条没标任何能当证据的词（老条目） | **不算脏**，无从判，留着 |
| `no_lyric` | 平台上搜不到这首歌 | **不算脏**，无从判，留着 |
| 死歌名 | 歌名在库里，可按歌名一条也捞不回来 | 没人拉得到，可清 |

后三档刻意不当脏处理：**宁可漏，不可错杀** —— 删掉一条别人做好的主题，比留着一条可能错的糟得多。

确认过报告之后才谈删除：

```bash
npx tsx scripts/scan-dirty-cache.mts --delete --admin-user <账号> --admin-pass <密码> --yes
```

删除走管理接口（`/admin/login` 拿 cookie + `DELETE /admin/api/ai-cache/stage/:key`），被覆盖前的旧版还在 `ai_cache_backups` 里，管理员面板能捞回来。**不给 `--delete` 就一个字节都不改**。

扫的那两个接口（`/api/ai-cache/songs` 与 `/api/ai-cache/resolve`）本来就是公开的，所以不需要 wrangler、不需要登录 Cloudflare；一个歌名最多看到 12 条候选（服务端 `MAX_RESOLVE_CANDIDATES`），版本特别多的歌名可以用 `--only` 分片。

---

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
