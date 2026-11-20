# 同步服务 HTTP 契约

自建同步服务（`sync-server/`）对外暴露的完整 HTTP 面。以 `sync-server/src/app.ts` 为准 —— 包括它用 `app.route()` 挂上去的子路由模块。部署形态、环境变量、Token 怎么生成见 [`sync-server/README.md`](../../sync-server/README.md)，本文只写线上契约。

- 三种部署（Cloudflare Workers、Docker、Node）共用同一套路由与同一份 D1/SQLite 兼容的数据访问（`sync-server/README.md` 的「实现定位」段），因此下列契约与部署形态无关。
- 客户端侧实现是 `src/services/sync/syncClient.ts`，响应解析是 `src/services/sync/syncSchema.ts`。客户端把**任何非 2xx 都当成失败**并只保留状态码（`syncClient.ts:60-62`），所以错误响应体是给人（与面板）看的，不是给调用方分支用的。

## 1. 请求先过三层全局中间件

| 顺序 | 作用范围 | 行为 | 依据 |
| --- | --- | --- | --- |
| 1 | 所有路径 | `/admin` 与 `/admin/*`：加 `Cache-Control: no-store`；管理员未配置 → `503 {ok:false,error:'admin_not_configured'}`；写操作跨源 → `403 {ok:false,error:'invalid_origin'}`。其余路径走公开 CORS：`Access-Control-Allow-Origin: *`、允许 `GET/POST/PUT/PATCH/DELETE/OPTIONS` 与 `Authorization, Content-Type` | `app.ts:289-303` |
| 2 | 所有路径 | `SYNC_TOKEN` 缺失或短于 8 字符 → `500 {ok:false,error:'SYNC_TOKEN is too weak. Must be at least 8 characters long.'}`。**公开接口也一起被拦**（它挂在 `app.use('*')`） | `app.ts:306-311` |
| 3 | 除 `/` 以外的所有路径 | 首次请求时建表/升级（`settings`、`themes`、`theme_buckets`、`font_market`、`font_files`、`font_previews`、`ai_cache`、`ai_cache_hits`、`ai_cache_backups`、`admin_sessions`），同一实例只做一次 | `app.ts:314-319`、`80-233` |

注意：`/admin` 的判断在**路由之前**，所以连 `/admin` 登录页本身也受「管理员必须已配置 + 同源」两道限制；而 `/admin/api/stats.svg` 虽然不带登录（见 §6.5），仍会先过这一层，未配置管理员时回 503 而不是图片。

## 2. 鉴权

| 方式 | 用在哪 | 细节 | 依据 |
| --- | --- | --- | --- |
| Bearer Token | `/state`、`/settings*`、`/themes/*`（即挂在兜底网 `api` 上的全部路由） | 头 `Authorization: Bearer <SYNC_TOKEN>`。缺失或不对 → `401`（纯文本 `Unauthorized`，带 `WWW-Authenticate`）；头格式不合 Hono 的 token 正则 → `400`（纯文本 `Bad Request`） | `app.ts:494-500` |
| 管理员会话 Cookie | `/admin` 的页面与 `/admin/api/*`（`stats.svg` 除外） | Cookie 名 `folia_admin_session`，HttpOnly、SameSite=Lax、12 小时、https 公开源时加 Secure；剩余不足 10 小时且访问面板时滚动续期；用户名/密码轮换后旧 session 立即失效 | `admin.ts:13-15`、`92-127`、`130-136` |
| 看板 Token | 只有 `GET /` | `?token=<DASHBOARD_TOKEN>`，不匹配就 `404` 纯文本 `Not Found`；是只读页面，不是客户端 API | `app.ts:322-328` |
| 写入令牌或管理员会话（配了才校验） | **只有** `PUT /api/ai-cache/*`（读、`/resolve`、`/songs` 仍然公开） | 二选一：头 `X-Folia-Cache-Token` 等于 `AI_CACHE_WRITE_TOKEN`（常量时间比较），或带管理面板会话 Cookie。**两样都配了但都不匹配 → `401 {"ok":false,"error":"unauthorized"}`**；**两样都没配 → 放行**，`writer` 记成 `anonymous`（云缓存是公开服务，写入另有歌词核验与摘要兜底；默认部署要能攒起缓存）。写入成功后 `writer` 记成 `token:<摘要前 12 位>`、`admin:<用户名>` 或 `anonymous` | `admin.ts` 的 `requireCacheWriter` |
| 无 | `/health`、`/favicon.*`、`/api/fonts*`、`GET /api/ai-cache*`、`/stage*`、`/api/stage-gallery*` | 刻意公开：字体市场与云缓存要能被「从没填过 Key 的播放器」读到。AI 缓存的**写入**是例外，见上一行 | `app.ts:715-721`、`725-732` |

两个容易踩的点：

- `SYNC_TOKEN` 至少 8 字符只是**下限**；Bearer 头必须匹配 `[A-Za-z0-9._~+/-]+=*`，含空格、中文、冒号等字符的 Token 永远拿到 400，看起来像「Token 不对」。
- 管理面板的写操作要过同源校验：`Origin` 有值时必须等于配置的公开源，且 `Sec-Fetch-Site` 不能是 `cross-site`；没有 `Origin` 的非浏览器脚本（curl、脚本）照常可以登录。`ADMIN_PUBLIC_ORIGIN` 格式错误会直接关掉整个管理入口（`admin.ts:37-58`）。

## 3. 路由挂载顺序（为什么有些必须挂在兜底网之前）

`app.ts` 末尾是 `app.route('/', api)`（`app.ts:795`）：它把 `api` 这个 Hono 实例挂在根上，于是**所有未被前面认领的路径都会先过 Bearer 校验**。由此得到两条硬规则：

1. 公开路由必须注册在 `app.ts:795` 之前。没认领的路径 → 先 401，而不是 404：访客拿不到 token，所以 `/stage` 挂到兜底网后面就「谁也进不来」（注释原文在 `app.ts:725-730`）。
2. 浏览器自动请求的 `/favicon.ico` 也必须挂在前面，否则后台每次打开都留一条 401，看着像坏了（`app.ts:764-772`）。

注册顺序一览（同一条注释里也写了各自的原因）：

```text
GET  /                      看板（DASHBOARD_TOKEN 门）        app.ts:322
GET  /health                连通性                            app.ts:492
route /api/fonts            字体市场（公开）                  app.ts:722
route /api/ai-cache         AI 云缓存（公开）                 app.ts:723
route /stage                访客检索页（公开，必须在兜底网前） app.ts:731
route /api/stage-gallery    访客检索接口（公开）              app.ts:732
route /admin                登录/退出/会话                    app.ts:735
GET  /admin                 面板页                            app.ts:736
route /admin/api/fonts      管理员字体                        app.ts:743
route /admin/api/ai-cache   管理员缓存                        app.ts:744
route /admin/api/ai-cache-backups  覆盖副本                    app.ts:745
route /admin/cache          缓存详情页                        app.ts:753
route /admin/api            stats.svg（不带登录）              app.ts:755
GET  /admin/api/stats       统计 JSON（要登录）               app.ts:756
GET  /favicon.svg /favicon.ico   （必须在兜底网前）             app.ts:786、791
route /  (api)              /state、/settings*、/themes/*      app.ts:795
```

## 4. 同步数据（Bearer）

### `GET /state`
依据：`app.ts:502-516`
```ts
{ schemaVersion: 2; settingsUpdatedAt: string | null; themesUpdatedAt: string | null; themeCount: number }
```
空库时两个时间戳为 `null`，`themeCount` 为 `0`（不是 null）。

### `GET /settings`
依据：`app.ts:518-524`
```ts
{ schemaVersion: number; updatedAt: string; data: Record<string, unknown> } | null
```
空库回 JSON `null`（客户端解析成「没有远端设置」，`syncSchema.ts:106-116`）。存储体就是客户端上一次 `PUT` 的原样 JSON，服务端不裁剪字段。

### `GET /settings/confirmation`
依据：`app.ts:528-531`；响应构造在 `settingsConfirmation.ts:16-20`
```ts
{ protocol: 'settings-cas-v1'; revision: string | null; record: SettingsRecord | null }
```
响应带 `Cache-Control: no-store`。`revision` 是「现有行 `updated_at` + `value_json` 的 SHA-256」，不是客户端时钟；空库时 `revision` 与 `record` 都是 `null`。客户端拿不到这个端点会明确报「升级服务端」，不退回盲写（`syncClient.ts:87-96`）。

### `PUT /settings`
依据：`app.ts:533-566`；CAS 实现 `settingsConfirmation.ts:22-42`
请求体：
```ts
{ schemaVersion: 1 | 2; updatedAt: string; data: Record<string, unknown>; expectedRevision?: string | null }
```
- `schemaVersion` 接受 1 **与**服务端的 2（历史导出一直是 1，`app.ts:535-536`）；`updatedAt` 必须是字符串、`data` 必须是对象，否则 `400 {ok:false,error:'invalid_settings'}`。
- 带 `expectedRevision`（新客户端）：`null` 或 64 位小写十六进制，否则 `400 invalid_revision`；与当前 revision 不符 → `409 settings_conflict`；CAS 没写成 → 同样 `409 settings_conflict`。成功回：
```ts
{ ok: true; accepted: true; protocol: 'settings-cas-v1'; revision: string; record: SettingsRecord }
```
服务端自己生成单调的 `updatedAt`（不小于旧值 + 1ms），客户端保存前会核对回显的 `data` 与上传的一致（`syncClient.ts:102-118`）。该响应同样 `no-store`（`app.ts:540`）。
- 不带 `expectedRevision`（旧客户端）：按时间戳 last-write-wins 写入，回 `{ ok: true }`。注意这条路径**可能什么都不写**（SQL 带 `WHERE excluded.updated_at >= settings.updated_at`，`app.ts:552-562`），旧客户端无法区分，这是已知的历史局限。

### `GET /themes/manifest`
依据：`app.ts:270-285`、`526`
```ts
{ schemaVersion: 2; bucketCount: 256; buckets: Array<{ bucketId: number; count: number; hash: string; updatedAt: string | null }> }
```
`buckets` **总是 256 条**（缺的用 `count: 0, hash: '0', updatedAt: null` 补齐）；`hash` 是字符串化的 32 位无符号数。

### `POST /themes/get`
依据：`app.ts:568-581`
- 请求体：`{ fingerprints?: string[] }`。非字符串、空串会被丢掉并去重，最多取前 500 个（`MAX_THEME_BATCH_SIZE`，`app.ts:58`）。
- 响应：`{ themes: Array<{ fingerprint: string; theme: object; source: 'manual'|'auto'|'fallback'|'edited'; updatedAt: string }> }`。没有命中回 `{ themes: [] }`；**不做 404**。

### `POST /themes/put`
依据：`app.ts:583-669`；输入校验 `246-259`
- 请求体：`{ themes: Array<{ fingerprint: string; theme: object; updatedAt: string; source?: string }> }`。
- 任一条不合规（`fingerprint` 非空字符串、`updatedAt` 字符串、`theme` 是对象）或条数 > 500 → `400 {ok:false,error:'invalid_themes'}`。`source` 不在四个枚举里时按 `'manual'` 存。
- 每条按 `updatedAt` 逐条 LWW（旧时间戳不覆盖新记录，`app.ts:631-647`），同时增量维护 256 个 bucket 的 `count` 与异或 `hash`。
- 响应：`{ ok: true; savedCount: number }`；空数组回 `savedCount: 0`。

### `POST /themes/bucket`
依据：`app.ts:671-689`
- 请求体：`{ bucketIds?: number[] }`。只收 `0..255` 的整数，去重后最多 32 个（`MAX_THEME_BUCKET_REQUEST_SIZE`）；没有合法 id 回 `{ themes: [] }`。
- 响应同 `/themes/get`，按 `fingerprint` 升序。

### `POST /themes/list`
依据：`app.ts:691-713`
- 请求体：`{ cursor?: string; limit?: number }`；`cursor` 缺省为 `''`，`limit` 缺省 500、夹在 `1..1000`。
- 响应：`{ themes: ThemeRecord[]; cursor: string | null }`；只有「刚好取满一页」才给下一页 `cursor`，否则 `null`（`app.ts:709-712`）。

## 5. 公开接口（无 Bearer）

### 5.1 字体市场
依据：`sync-server/src/fonts.ts`

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /api/fonts` | 查询 `category`（空/`all` 表示不过滤）、`q`（比 name/family/分类标签）、`page`（默认 1）、`pageSize`（默认 24，上限 60） | `{ ok: true; fonts: FontEntry[]; total: number; page: number; pageSize: number; hasMore: boolean }` —— `fonts` 只含 `enabled = 1` 的条目 | 无 4xx |
| `GET /api/fonts/:id/file` | — | 字体二进制，`Content-Type` 取存的 mime，`Cache-Control: public, max-age=31536000, immutable` | `404 {ok:false,error:'not_found'}` |
| `GET /api/fonts/:id/preview` | — | 预览图二进制，`Cache-Control: public, max-age=86400` | `404 {ok:false,error:'not_found'}` |

`FontEntry`（`fonts.ts:74-92`）：`{ id, name, family, category, categoryLabel, license, fileName, mimeType, fileSize, fileUrl, previewUrl, previewAspect, enabled, sort, createdAt, updatedAt }`。`fileUrl`/`previewUrl` 是站内相对路径，可直接拼在服务根地址后；`previewAspect` 固定 3（图未到时先占位，`fonts.ts:41`）。上传限制：字体 ≤ 40MB、预览 ≤ 2MB（`fonts.ts:19-20`）。

### 5.2 AI 云缓存
依据：`sync-server/src/aiCache.ts`

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /api/ai-cache/:kind/:key` | `kind` 匹配 `^[a-z0-9_-]{1,32}$`、`key` 是 32 位十六进制（歌词文件 MD5） | `{ ok: true; hit: boolean; entry: AiCacheEntry \| null }`；命中时 `hits` 自增并记一条命中流水 | `400 {ok:false,error:'invalid_key'}` |
| `PUT /api/ai-cache/:kind/:key` | `{ payload, songTitle?, provider?, model?, platform?, lyricHash?, isPureMusic? }`；配了写入准入时按 §2 校验（没配则放行） | `{ ok: true; stored: true; entry: { writer, payloadDigest, verifyKey }; verification: { status: 'verified'\|'word_matched'; platform: string; source: string\|null; note: string } }` | `401 unauthorized`（配了准入但没凭证或凭证不对）、`413 payload_too_large`（请求体 > 128KB）；`400 invalid_key`；`400 empty_payload`、`400 invalid_payload`（非对象 / 超 64KB）、`400 lyric_mismatch`、`400 no_lyric_evidence`、`400 lyric_unavailable`（上传校验，见 `stageVerifier.ts`） |
| `POST /api/ai-cache/resolve` | `{ kind: string; songTitle: string }` | `{ ok: true; candidates: Array<{ key, songTitle, platform, provider, model, updatedAt, words: string[] }> }`；最多 12 条候选 | 输入不合法也回 `200 {ok:true,candidates:[]}`（刻意不报错） |
| `GET /api/ai-cache/songs` | 查询 `limit`（默认 60，上限 200）、`offset`（≥0）、`q`（按歌名筛，LIKE 通配符已转义） | `{ ok: true; total: number; limit: number; offset: number; songs: Array<{ songTitle, platform, key, updatedAt, hits, versions }> }` | 无 4xx |

- `AiCacheEntry`（`aiCache.ts`）：`{ kind, key, payload, songTitle, provider, model, platform, payloadBytes, hits, createdAt, updatedAt, writer, payloadDigest, verifyKey }`；老条目缺的字符串字段回 `''`（`aiCache.ts` 的 `mapRow`），`payload` 解析失败回 `null`。
- **内容完整性**（issue C6）：写入时服务端算 `payloadDigest = SHA-256(JSON.stringify([verifyKey, kind, key, writer, payloadJson]))`（`aiCacheDigest.ts`，`verifyKey` 目前是 `folia-cache-digest-v1`），随条目一起发给读的人。客户端照同一套规则复算（`src/services/aiCloudCache.ts` 的 `verifyEntryDigest`），对不上就**当没命中**。摘要绑定「写在哪、谁写的、写了什么」，所以挪键、改库、旁路写入都能被发现；它不是签名，服务端自己的管理员仍能改写自己的条目。
- 覆盖是**同键替换**（`hits` 与 `created_at` 保留），覆盖前旧版进 `ai_cache_backups`（连 `writer` 与 `payload_digest` 一起存），每键最多 10 份。
- 上传校验**没有关闭开关**（issue C6）：`AI_CACHE_VERIFY` 已删除。缺 `lyricHash` → `no_lyric_evidence`；平台与歌名都查不到歌词 → `lyric_unavailable`。两者以前都会「降级放行」，而放行的后果是一条无法核验的内容进全局共享表。纯音乐用 `md5(songTitle)` 作 `lyricHash` 通过校验。
- 服务端只存 `payload` 与元数据：不存提示词、不存歌词正文、不存任何凭据（`aiCache.ts` 文件头）。

### 5.3 访客检索页
依据：`sync-server/src/stageGallery.ts`、`stageGalleryView.ts`

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /stage` | `?q=`（截断到 64 字符） | 服务端渲染的搜索页 HTML | 无 |
| `GET /stage/entry/:key` | `key` 必须是 32 位十六进制 | 服务端渲染的详情页 HTML | 键不合法或没有该条 → `404` HTML 提示页 |
| `GET /api/stage-gallery/search?q=&limit=` | `q` 截断 64 字符；`limit` 被夹到 1..60（`stageGalleryView.ts:17,545`；默认 24，`stageGalleryView.ts:16`） | `{ ok: true; query: string; count: number; html: string; entries: GalleryEntry[] }` —— `html` 是服务端渲染好的结果片段（转义只在服务端做一遍） | 内部查询出错时按空结果回，不 5xx |

页面里每个字都来自任何**带写入准入的** PUT 的 payload（issue C6 之后不再是「任何人」）：文本转义、颜色只认 `#rgb`/`#rrggbb`（`sync-server/README.md` 的「访客检索页」）。

## 6. 管理面板（Cookie 会话）

登录相关的契约（依据 `admin.ts:160-194`）：

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `POST /admin/login` | JSON 或表单：`{ username, password }`（`Content-Type` 含 `application/json` 走 JSON，否则按表单解析） | `{ ok: true; username: string; usingDefault: false }`，同时 `Set-Cookie: folia_admin_session=...` | `503 admin_not_configured`；`401 invalid_credentials` |
| `POST /admin/logout` | — | `{ ok: true }`，删除 session 与 cookie | — |
| `GET /admin/session` | — | `{ ok: true; signedIn: boolean; username: string \| null; usingDefault: false }` | — |
| `GET /admin` | — | 未登录：登录页 HTML；已登录：面板页 HTML（顺带清理过期 session 并续期） | — |

管理员凭据只来自环境变量：`ADMIN_USERNAME` 非空且 `ADMIN_PASSWORD`（去掉两端空白后）至少 16 字符，否则所有 `/admin*` 都是 503；没有内置账号（`admin.ts:29-34`）。

### 6.1 字体管理（`/admin/api/fonts`，依据 `fonts.ts:331-442`）

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /` | — | `{ ok: true; fonts: FontEntry[] }` —— 含停用的，一次给全 | — |
| `POST /` | `multipart/form-data`：`file`（必填，扩展名或 mime 合法且 ≤40MB）、`preview`（必填，≤2MB）、`name`、`category`、`license`（截断 200 字） | `{ ok: true; font: FontEntry }` | `400 invalid_font_file`；`400 missing_preview` |
| `PATCH /:id` | JSON，可含 `name`、`category`、`license`、`enabled`（布尔）、`sort`（数字）；只改提供了的字段 | `{ ok: true; font: FontEntry \| null }` —— id 不存在时 `font` 为 `null`（不 404） | `400 invalid_body`（请求体不是 JSON） |
| `DELETE /:id` | — | `{ ok: true }`；同时删掉字体与预览的字节 | —（幂等：id 不存在也回 ok） |

上传字段的大小与 mime 判定在 `fonts.ts:261-278`；`category` 只认 `sans/serif/handwriting/display/mono`，其余归 `sans`（`fonts.ts:57-72`）。

### 6.2 缓存管理（`/admin/api/ai-cache`，依据 `aiCache.ts:664-757`）

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /` | 查询 `kind`、`q`（按 `cache_key` 或 `song_title` 模糊）、`limit`（默认 200，上限 500） | `{ ok: true; entries: AiCacheEntry[]; total: number; limit: number }` —— `total` 是整库（或筛完）的条数，不是这一页 | 不合法的 `kind` 只是被忽略，不报错 |
| `DELETE /:kind/:key` | — | `{ ok: true }` | `400 invalid_key` |
| `DELETE /` | 查询 `kind`（可选） | `{ ok: true }`；带 `kind` 只清那一类，不带清全表 | `400 invalid_kind` |

### 6.3 覆盖副本（`/admin/api/ai-cache-backups`，依据 `aiCache.ts:824-859`）

| 方法/路径 | 请求 | 响应 | 错误 |
| --- | --- | --- | --- |
| `GET /:kind/:key` | — | `{ ok: true; limit: 10; backups: BackupEntry[] }`（新的在前；`BackupEntry` 比 `AiCacheEntry` 多 `id` 与 `archivedAt`，见 `aiCache.ts:109-131`） | `400 invalid_key` |
| `POST /:id/restore` | — | `{ ok: true; restored: number }`；当前那条会先存进备份再被覆盖，被捞的那份用完即删 | `400 invalid_id`；`404 not_found`（副本已被另一次恢复消费或已裁掉） |

### 6.4 缓存详情页（页面，依据 `adminCachePages.ts:62-127`）

| 方法/路径 | 响应 | 说明 |
| --- | --- | --- |
| `GET /admin/cache/:kind/:key` | HTML | 当前版本按访客检索页那套渲染（色块 + 高亮词本色），下面挂被覆盖留下的旧版 |
| `GET /admin/cache/backups/:id` | HTML | 单独看某一版副本 |
| `POST /admin/cache/backups/:id/restore` | `303` 重定向回 `/admin/cache/:kind/:key` | 供表单提交；失败时回 HTML 提示 |

这三条**错误也用 200 回**（`html()` 没有设 status，`adminCachePages.ts:58-60`），只有成功恢复那条是 303。这与 JSON 接口的行为不同，写脚本时不要按 404 判失败。

### 6.5 统计
依据：`app.ts:754-762`；`statsImage.ts:311-350`

| 方法/路径 | 鉴权 | 响应 |
| --- | --- | --- |
| `GET /admin/api/stats` | 管理员会话（`requireAdmin`） | `{ ok: true; fontCount: number; fontBytes: number; cacheCount: number; cacheBytes: number; totalHits: number; kindCounts: Record<string, number> }` |
| `GET /admin/api/stats.svg` | **无登录**（刻意不挂 `requireAdmin`），但仍要管理员已配置（见 §1） | `image/svg+xml`，`Cache-Control: no-store`；查询 `minutes` 默认 5。出错回 `500 {ok:false,error:'stats_unavailable'}` |

## 7. 限制与常量（客户端会撞上的硬边界）

| 项 | 值 | 依据 |
| --- | --- | --- |
| 服务端 schema 版本（`/health`、`/state`、manifest） | `2` | `app.ts:56` |
| `PUT /settings` 接受的 `schemaVersion` | `1` 或 `2` | `app.ts:536` |
| 主题 bucket 数 | 256 | `app.ts:57` |
| 一次 `/themes/put` 条数 / 一次 `/themes/get` 指纹数 | 500 | `app.ts:58`、`568-572` |
| 一次 `/themes/bucket` 的 bucket 数 | 32 | `app.ts:59` |
| `/themes/list` 页大小 | 默认 500，最大 1000 | `app.ts:60-61`、`694-697` |
| 字体文件 / 预览图 | 40MB / 2MB | `fonts.ts:19-20` |
| 字体目录页大小 | 默认 24，最大 60 | `fonts.ts:32-33` |
| AI 缓存 payload | 64KB（JSON 序列化后的 UTF-8 字节） | `aiCache.ts:21`、`133-144` |
| `kind` / `key` 形状 | `^[a-z0-9_-]{1,32}$` / `^[a-f0-9]{32}$` | `aiCache.ts:32-33` |
| 每键备份份数 / 命中流水保留 | 10 / 7 天 | `aiCache.ts:30`、`160` |
| 管理 session | 12 小时，剩余 <10 小时续期 | `admin.ts:14-15` |
| 歌名/元数据截断 | 200 / 64 / 128 字符 | `aiCache.ts:22,28,287` |

## 8. 与客户端的兼容约定

- 客户端解析器会**拒绝**不合规的响应，而不是猜测：设置记录要求 `schemaVersion` 为 1 或 2、`updatedAt` 可解析、`data` 是对象（`syncSchema.ts:27-28,106-116`）；每个字段再按类型逐条过滤（`syncSchema.ts:46-104`）。
- 新服务端 + 旧客户端：旧客户端不带 `expectedRevision`，走 §4 的 LWW 路径；新服务端仍然回 `{ok:true}`。
- 旧服务端 + 新客户端：`/settings/confirmation` 拿不到就明确失败、要求升级服务端（`syncClient.ts:87-96`），主题同步可单独继续。
- 未知路径：没有 Bearer → 401；有 Bearer → 404。不要用 404 判断「这个服务端有没有某个接口」，先看 `/health` 的 `schemaVersion`（`app.ts:492`）。
