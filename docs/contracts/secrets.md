# 凭据与密钥：存放与流动规则

一句话：凭据要么待在**只有它能解密的那一层**（系统钥匙串 / 主进程 / 安卓 Keystore），要么只在**一次请求的内存里**经过渲染进程；除此之外的每一条路（前端包、同步与导出、日志）都当成公开的。

## 1. 哪些值是凭据

| 值 | 谁产生/持有 | 桌面端 | 安卓端 |
| --- | --- | --- | --- |
| AI API Key（Gemini / OpenAI 兼容） | 用户输入 | 主进程 `electron-store`，safeStorage 密文（§2.1） | WebView `localStorage`（§5 遗留） |
| 音乐平台登录态（cookie / session / musickey / device id） | 平台登录 | 主进程 safeStorage 密文（酷狗/QQ/Spotify/YouTube Music/汽水）；网易云等仍在渲染进程 `localStorage`（§5） | 原生 Keystore 或 WebView 存储，各平台不同（§2.3） |
| 同步服务 `SYNC_TOKEN`、服务地址 | 用户填写 | 渲染进程 `localStorage`（§5 遗留） | 同左 |
| 看板 `DASHBOARD_TOKEN`、管理员账号密码 | 部署者 | 服务端环境变量，永不进客户端 | — |
| 汽水协议凭据（cookie / token / qr / oauth 四个文件） | 汽水协议层 | `userData` 下的纯文本文件，0600（§2.1 的例外） | 协议层私有存储（§2.3） |
| `QQ_SESSION_SECRET` 等 serverless 密钥 | 部署者 | Vercel/Cloudflare 环境变量 | — |
| 舞台 Token、OBS 浏览器源 Token | 应用自己生成 | 主进程 `electron-store` 明文；舞台 Token 会交给渲染进程（§5） | — |
| 第三方 mod 的 secret | mod 调用主进程写入 | 主进程 safeStorage 密封，渲染进程只能按 key 存取（`electron/modSystem/modSecrets.cjs:7-9,43-52`） | — |

## 2. 允许出现在哪里

### 2.1 主进程 `electron-store`（`config.json`）与系统钥匙串

`electron-store` 写的是明文 JSON，所以**凭据不许直接 `store.set`**。允许的形态只有两种：

1. **safeStorage 密文**：用 Electron 的 `safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret 或 kwallet），磁盘上只有密文。AI Key 的实现在 `electron/aiCredentialStore.cjs:1-20`（动机注释）、`181-194`（写入时先加密）；读取失败（换机器、钥匙串锁着）时当作「没配」，不覆盖密文（`101-125`）。
2. **明确记录的例外**：汽水协议层自己按纯文本读写四个凭据文件，加密后它无法解析，所以只做权限收紧（`0600`）并写清原因（`electron/qishui/credentials.cjs:6-26`）。这是**协议约束下的例外**，不是通用做法。

各平台会话的具体落点（主进程那几路都走 safeStorage，且多数在不可用时选择「不落盘」而不是明文落盘；例外见 §5）：

| 平台 | 存放 | 依据 |
| --- | --- | --- |
| 网易云 / 酷狗 / QQ / Spotify / YouTube Music | 主进程会话库，safeStorage 密文；酷狗、QQ 要求加密可用，Linux 的 `basic_text` 后端直接拒绝 | `electron/kugou/kugouApiBridge.cjs:94-141`、`electron/qq/qqAuthSessionRepository.cjs:1-6,126-130`、`electron/spotify/session.cjs:21-37`、`electron/ytm/session.cjs:19-37` |
| 汽水（桌面） | 会话 safeStorage 密文；加密不可用就只留内存，删除已存的键 | `electron/qishui/session.cjs:39-49` |
| AI API Key | safeStorage；Linux 没有真钥匙串时**退回明文并只警告一次**（历史兼容） | `electron/aiCredentialStore.cjs:13-15`、`181-194` |

`safeStorage` 能力本身抽在 `electron/osEncryption.cjs:11-24`：`isEncryptionAvailable()` 为假、或 Linux 选了 `basic_text`，都算「不能加密」。Linux 桌面的后端选择在 `electron/linuxPasswordStore.cjs:34-47`（KDE 交给 Chromium 自己判断，其余用 libsecret）。

**主进程只回「有没有配」，不回 Key 本身**：`getPublicSettings()` 会把 `GEMINI_API_KEY` / `OPENAI_API_KEY` / 密文键删掉，换成布尔 `AI_API_KEYS_CONFIGURED`（`electron/aiCredentialStore.cjs:217-228`）。渲染进程测试连接时可以带「刚输入的 Key」，留空表示「用已保存的」，但自己读不到已保存的值（`src/vite-env.d.ts:50-57`；读取入口 `resolveTestApiKey` 在 `aiCredentialStore.cjs:237-247`）。

### 2.2 渲染进程内存

- 允许：用户刚输入、还没保存的 Key；一次请求的 Authorization 头；已保存 Key 的**布尔状态**。
- 允许短暂存在：主进程为某个功能主动下发的本地 Token（舞台 Token 在 `StageStatus` 里回给渲染进程，`electron/stageApi.cjs:313`）。这类 Token 只在本机回环服务上有效，仍按凭据对待：不写日志、不入同步/导出。
- 桌面端渲染进程**不持久化** AI Key；持久化的是 `localStorage` 里的「是否已配」布尔与端点（`src/components/modal/settings/useElectronSettingsPanel.ts:112-122,207-217`）。

#### 旧版 AI 兼容接口设置迁移（#54）

- Web / Android 的 `foliaAiProviderSettings` 旧 `openaiApiKey`、`openaiApiUrl` 指「其他兼容接口」，只迁入 `custom`；旧 `openaiApiModel` 同时供 custom / DeepSeek 使用，不复制 Key 给官方 `openai`；已有新字符串值（含空串）与 `apiStream:false` 优先。读取只在内存归一化，不写盘、不发事件。
- 修复前曾把同一 Key 自动复制给 `openai` / `custom`。旧字段消失后，无法区分误迁移和用户主动复用 Key：未带确认版本且官方 Key 与 custom Key / 旧兼容 Key 相同的记录，内存里暂停使用官方副本（显示为空、按未配置处理），**不自动改发到 custom 地址**。原始磁盘数据在纯读取时保留；其余 provider、custom Key / 地址保持。
- 用户可在「设置 → AI」手动选择 `custom` 继续用原地址；要用官方则重新填写官方 Key。显式保存才写 `credentialRoutingVersion:1`，先从已归一化的设置合并 patch；无关设置保存不能复活暂停的副本。用户此后主动为两家填写同一 Key 不会再次被拦。标记只存在存储层，不进入公共 `AiSettings` 返回值或事件。
- 旧地址为空不代表已确认官方目的地：迁入 custom 后必须填写地址，请求 resolver 报 `CUSTOM_API_URL is not configured`，不会走共享 helper 的官方默认地址。连接测试同样零请求。
- 这是保守的兼容性取舍：升级前主动复用同一 Key 的人也需重新确认；如果旧副本已被改成不同值且旧字段已丢失，无法推断其来源。本次不宣称能恢复所有历史配置，也不改变 WebView 明文存储的遗留风险。

### 2.3 安卓原生

- 有加密的：YouTube Music 会话用 Android Keystore 里应用专属的 AES-GCM 密钥加密，密文写 `getNoBackupFilesDir()`（不进云备份），密钥不出应用；解不开就整份丢弃、让用户重登（`android/app/src/main/java/top/izuna/foliamajor/YtmSessionStore.java:23-35,58-77,97-147`）。
- 没有加密层的：汽水协议层把持久化数据写进应用私有 `SharedPreferences`（`folia_qishui`，MODE_PRIVATE，明文）（`android/app/src/main/java/top/izuna/foliamajor/QishuiSignHost.java:69-73`）。
- 其余平台在安卓上走 `src/nativeBridge/` 的 JS 实现，登录态落在 WebView 存储（`localStorage`/`IndexedDB`），不是原生加密存储。

### 2.4 服务端

- 管理员账号密码只从环境变量读，缺失或弱配置就关掉管理入口（`sync-server/src/admin.ts:29-34`）；库里只存 session 的 `credential_tag`（用户名与密码的 SHA-256），不存密码（`admin.ts:60-64,145-153`）。
- 同步 Token 只与请求头里的值做定长比较，不落库（`sync-server/src/app.ts:496-500`）。
- AI 云缓存只存生成结果与元数据：没有提示词、没有歌词正文、没有任何凭据（`sync-server/src/aiCache.ts:19`）。

## 3. 绝对不允许

### 3.1 不许进 `VITE_` 环境变量（会被内联进前端包）

- 构建期 `import.meta.env.VITE_*` 会被静态替换进前端资源，产物里能读到的就是公开的。仓库里对这条已有明文：`docs/qq-music-deployment.md:44`（「`QQ_SESSION_SECRET` 不要加 `VITE_` 前缀，不要写进仓库、截图、构建日志或镜像。带 `VITE_` 前缀的变量会被编进前端资源。」）。
- `.env.example` 里 `VITE_*` 全是**地址与开关**（`VITE_NETEASE_API_BASE` 等，`.env.example:4-42`），而 Key 刻意不带前缀：`GEMINI_API_KEY`（`.env.example:46`）、`OPENAI_API_KEY`（`.env.example:52`）。这些非 `VITE_` 变量只给服务端（`api-ts/generate-theme.ts:90`、`api-ts/generate-theme_openai.ts:365`）与部署配置用。
- `.env` 与 `.env.*` 全部被忽略，只提交示例（`.gitignore:141-144`）。
- 前端只能读「地址类」构建变量：`src/services/webApi.ts:22`、`src/services/runtimeConfig.ts:15` 等，没有任何地方读 `VITE_*KEY*`。

### 3.2 不许进同步 / 导出 payload

- 同步的设置文档只由视觉设置构造：`buildSyncedVisualSettings` 逐字段列出，没有任何凭据字段（`src/services/sync/settingsSnapshot.ts:32-88`；形状定义 `src/services/sync/syncTypes.ts:27-81`）。同步请求头带 Token（`src/services/sync/syncClient.ts:50-57`），但**请求体里没有**。
- 「已确认基准」按 `[enabled, URL, token]` 的 SHA-256 隔离，不存明文 Token（`src/services/sync/syncCoordinator.ts:31`）。
- 同步库导出 zip 只有 `meta.json` / `themes/themes.json` / `settings/current.json` 三份（`src/services/sync/syncArchive.ts:24-40`）。
- 外观配置导入导出只有主题 + 视觉设置（`src/utils/appearanceCodec.ts:21-24`、`src/components/modal/settings/pages/storage/visualConfigTransfer.ts:46-60`），没有 Key。
- AI 云缓存上传的 payload 是生成结果；服务端明确「只存 payload，不存提示词、不存歌词、不存凭据」（`sync-server/src/aiCache.ts:19`），入库字段见 `aiCache.ts:287-305`。

### 3.3 不许进日志、诊断、错误消息

- 规则原文：日志里直接交抛出的错本身，但「凭据（cookie、token、密码）的值不写进日志行」（`AGENTS.md` 的「日志」一节）。
- AI 请求的错误与响应先脱敏再进日志：`src/services/aiCompletion.ts:107-111`（`redact`：Bearer、`x-goog-api-key`、URL 里的 key/token、JSON 里的 apiKey/authorization）、`electron/ai/requestText.cjs:15,29`（`redactUrl` / `redactSecrets`）。
- 登录诊断与失败详情只放可以公开贴出的内容：不含 cookie、token、IP、账号信息（`src/types/onlineMusic.ts:279,306,715-716`）。QQ 会话库的注释同样写明绝不把内部凭据交给渲染进程（`electron/qq/qqAuthSessionRepository.cjs:1-6`）。
- 管理面板只用 HttpOnly Cookie，页面脚本读不到 session（`sync-server/src/admin.ts:106-113`）。

## 4. 代码依据（按问题查）

| 想知道 | 看 |
| --- | --- |
| AI Key 怎么加密、失败怎么退化 | `electron/aiCredentialStore.cjs:1-20,69-81,101-125,142-194,217-247` |
| 加密能不能用 | `electron/osEncryption.cjs:11-34` |
| Linux 加密后端怎么选 | `electron/linuxPasswordStore.cjs:30-47`；主进程告警 `electron/main.cjs:5859-5863` |
| 渲染进程拿到的设置里有什么 | `electron/main.cjs:6262-6264`（`get-settings`）、`6329-6344`（`save-settings` 白名单） |
| 表单为什么不能回显已保存 Key | `src/vite-env.d.ts:50-57`、`src/components/modal/settings/useElectronSettingsPanel.ts:61-78,207-217` |
| 各平台会话落点 | `electron/kugou/kugouApiBridge.cjs:94-141`、`electron/qq/qqAuthSessionRepository.cjs:1-6,53-76,126-130`、`electron/spotify/session.cjs:16-37`、`electron/ytm/session.cjs:19-37`、`electron/qishui/session.cjs:39-49`、`electron/qishui/credentials.cjs:6-26`；仍在渲染进程的：`src/services/onlineMusic/netease/netease.ts:189,250`、`src/services/onlineMusic/providerStorage.ts:36-60` |
| 安卓加密 | `android/app/src/main/java/top/izuna/foliamajor/YtmSessionStore.java:23-35,58-77,97-147` |
| 舞台 / OBS Token | `electron/stageApi.cjs:245-257,313`；`electron/main.cjs:2642-2652,7078-7084` |
| 同步与导出带什么 | `src/services/sync/settingsSnapshot.ts:32-88`、`src/services/sync/syncArchive.ts:24-40`、`src/services/sync/syncCoordinator.ts:31` |
| 云缓存存什么 | `sync-server/src/aiCache.ts:19,287-305` |
| VITE_ 前缀的禁令 | `docs/qq-music-deployment.md:44`、`.env.example:4-52`、`.gitignore:141-144` |
| 脱敏 | `src/services/aiCompletion.ts:107-111`、`electron/ai/requestText.cjs:15,29` |
| 诊断不写凭据 | `src/types/onlineMusic.ts:279,306,715-716` |

## 5. 现状与遗留风险

按「已经这样、需要单独排期」列出，不要当成允许的写法：

1. **网页版把 AI Key 存在 `localStorage`**：`src/services/aiSettings.ts:109,168-208`。网页构建没有主进程，只能如此；风险是任何同源 XSS 都能读走。桌面版走主进程，不受这一条影响。
2. **同步 Token 存在渲染进程 `localStorage`**：`src/services/sync/syncConfig.ts:6,66-71`。它只在本机，不是主进程保管的密文；日志与导出已经避开它，剩下的是「同源脚本可读」这一层。
3. **Linux 没有真钥匙串时，AI Key 退回明文落盘**（只警告一次）：`electron/aiCredentialStore.cjs:13-15,189-192`。酷狗/QQ/汽水在同样环境下选择「不落盘」（`electron/osEncryption.cjs:21-23`、`electron/qishui/session.cjs:44-49`），AI Key 因为用户手输、丢了就得重填，才保留明文回退。
4. **网易云的登录 cookie 在渲染进程 `localStorage`**：`src/services/onlineMusic/netease/netease.ts:189,250`；网页/安卓版的酷狗 cookie、飞牛 token 同样走 `localStorage`（`src/services/onlineMusic/providerStorage.ts:36-60`、`src/services/onlineMusic/kugou/kugouTransport.ts:220-235`）。桌面端酷狗主进程只保留加密的 token/dfid，渲染层只留非敏感的 userid 提示（`kugouTransport.ts:238-247`）。
5. **汽水的四个协议凭据文件是明文**（权限 0600）：`electron/qishui/credentials.cjs:6-26`。加密会破坏协议层读取，只能等上游支持。
6. **安卓侧的加密不统一**：YouTube Music 有 Keystore，汽水协议层落在明文 `SharedPreferences`，其余平台落 WebView 存储（§2.3）。
7. **舞台 Token 与 OBS Token 明文存在 `electron-store`**，且舞台 Token 会经 IPC 交给渲染进程（`electron/stageApi.cjs:313`）。它们只在本机回环服务上有效，属于「本机凭据」而非账号凭据；仍然不要写进日志或截图。
8. **诊断报告、issue 与截图是手工贴的**：贴之前按 §3.3 检查；登录诊断已经过滤凭据，但路径、主机名、账号 id 仍可能出现在自定义内容里。

## 6. 改动时的检查清单

改任何与凭据有关的地方，逐条过一遍：

1. 新值是否真需要持久化？只需要一次请求的话，用完就丢。
2. 持久化在主进程还是渲染进程？渲染进程只允许内存 + 布尔状态（桌面端）。
3. 桌面端落盘必须走 `safeStorage` 密文，或像汽水那样在代码里写清「为什么只能明文」并收紧权限。
4. 安卓端优先 Keystore；落 `SharedPreferences` 要在文件头写明原因。
5. 有没有新字段进 `getPublicSettings()` / 同步文档 / 导出 zip / 云缓存 payload？逐一确认不含凭据。
6. 有没有新日志行、错误消息、诊断行可能带上值？按 §3.3 脱敏，并检查 `errorFields`/`errorMessage` 的用法（`src/utils/errorText.ts`）。
7. 有没有新增 `VITE_` 变量？只允许地址与开关。
8. 更新本文档与 [electron-ipc.md](electron-ipc.md)（若暴露面变了）。
