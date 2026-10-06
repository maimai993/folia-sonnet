# Folia 技术与开发说明

这份文档收纳仓库 README 中较细的部署、开发、桌面端和技术栈说明。更完整的使用指南也可以访问专门的文档站点：

- [Folia Guide](https://folia-site.cielaniska.top/guide/)
- [Stage API 文档](../test/manual/stage-client/README.md)

## 桌面端说明

桌面版内置前后端运行环境，适合希望即装即用的用户。最新版本请前往 [Releases 页面](https://github.com/chthollyphile/folia-major/releases)。

### 发布与更新通道

| 通道 | 面向对象 | 更新来源 | 网盘下载 |
| --- | --- | --- | --- |
| Realeco | 正式版 | `latest` | 提供 |
| Limo | Nightly | `beta`，也可升级到 Realeco | 不提供 |
| Cielo | Canary | `alpha`，也可升级到 Limo / Realeco | 不提供 |

Realeco 发布仅在 `main` 修改根目录 `realeco-release` 时触发。自动触发时，该文件必须只包含单行 `A.B.C`，并且必须同时与 `package.json` 版本、当前完整提交信息 `release: vA.B.C` 严格一致。手动触发作为应急入口，会跳过这两项一致性检查，直接使用当前 HEAD 的 `package.json.version`（仍必须是稳定的 `A.B.C`）打包。工作流创建草稿 Release；维护者在 GitHub 手动公开后，Realeco 客户端才会发现更新。

Cielo 的 `[canary]` 推送会更新滚动的 `cielo` prerelease，供 Cielo 通道客户端获取更新。手动运行 Cielo 工作流时可选择 `branch-release`，为当前分支和提交创建独立的 `cielo-<branch>-<sha>` prerelease，供人工下载和回归；该 Release 不参与客户端自动更新。选择 `artifacts` 则不创建 Release，只将各平台构建产物保留 14 天。

### Linux 获取方式

1. Arch Linux / Manjaro：通过 AUR 安装 `folia-major-bin`

```bash
yay -S folia-major-bin
```

2. Debian / Ubuntu / Linux Mint：下载 `.deb`
3. Fedora / RHEL / openSUSE：下载 `.rpm`
4. 其他发行版：下载 `tar.gz`，解压后直接运行 `folia-major`

`tar.gz` 包中附带图标与 `.desktop` 模板，可按需手动创建桌面启动项。

### Hyprland / Wayland 遥控窗

桌面端的外部遥控窗会作为主窗口的伴随窗口打开，并使用稳定窗口标题 `Folia Remote`。在 Hyprland 下，如果希望它以悬浮小窗方式出现，可以在 `hyprland.conf` 中添加类似规则：

```ini
windowrule {
  name = folia-remote
  float = on
  size = 520 315
  center = on
  pin = on
  no_blur = on
  border_size = 0
  no_shadow = on
  match:class = ^(folia-major)$
  match:title = ^(Folia Remote)$
}

```

不同打包方式下窗口 `class` 可能不同；如果规则没有生效，可以用 `hyprctl clients` 查看实际 `class` / `title` 后再调整匹配条件。

## 部署与开发

### 后端 API

本项目依赖 [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 提供音乐相关后端服务。

如果使用前端版本的话，需要先自行部署该 API 服务。

### AI 能力

Folia 当前支持以下两类 AI 提供方式：

- Google Gemini
- OpenAI 兼容 API，例如 DeepSeek、ChatGPT 接口等

Gemini 通常更适合当前项目场景，因为 JSON 输出相对稳定。

### Stage API

Folia 提供了从外部与播放器进行交互的 Stage API，从而可以实现外部程序与播放器的深度集成。可以通过 `npm run stage:client` 启动本地联调台，查看和测试这些接口的功能。

具体可参考 [Stage API 文档](../test/manual/stage-client/README.md)。

### 一键部署到 Vercel

如果你希望快速上线 Web 版本，可以直接通过下方入口创建 Vercel 项目：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/chthollyphile/folia-major)

部署完成后，请在 Vercel 项目设置中补齐环境变量。

### 本地开发

推荐使用 `vercel dev`，这样本地环境会更接近线上部署行为。

本项目要求 Node.js 24 或更高版本。

#### 1. 安装依赖

```bash
npm install
```

#### 2. 配置环境变量

在项目根目录创建 `.env.local`：

```bash
cp .env.example .env.local
```

如果你已经在 Vercel 中配置过环境变量，也可以直接拉取：

```bash
vercel env pull .env.local
```

然后按需填写以下变量：

| 变量名 | 描述 | 是否必需 |
| --- | --- | --- |
| `VITE_NETEASE_API_BASE` | 网易云音乐 API 实例地址 | 是 |
| `VITE_KUGOU_API_BASE` | Web 版的 KuGouMusicApi 实例地址；Electron 不使用此项 | 否，默认留空 |
| `VITE_FOLIA_API_BASE` | 自行托管的 Folia AI/歌词代理 API 根地址；Android 使用相关功能时必须为 HTTPS | 否，默认留空 |
| `VITE_AI_PROVIDER` | AI 提供商，`google` 或 `openai` | 是 |
| `GEMINI_API_KEY` | Gemini API Key | 使用 Gemini 时需要 |
| `OPENAI_API_KEY` | OpenAI 兼容 API Key | 使用 OpenAI兼容接口 时需要 |
| `OPENAI_API_URL` | OpenAI 兼容接口地址，可填 base URL 或完整 `chat/completions` 地址 | 使用 OpenAI兼容接口 时需要 |
| `OPENAI_API_MODEL` | 模型名，例如 `gpt-4o`、`gpt-4.1-mini`、`deepseek-v4-flash` | 使用 OpenAI兼容接口 时需要 |
| `OPENAI_API_TEMPERATURE` | 温度，范围 `0`–`2`；留空或无效时默认使用 `0.7` | 否 |

注意：部分模型对于温度参数有特殊要求，例如 `kimi-k3` 要求温度必须为 `1`。

Gemini 示例：

```env
VITE_NETEASE_API_BASE=http://localhost:3000
VITE_KUGOU_API_BASE=
VITE_FOLIA_API_BASE=
VITE_AI_PROVIDER=google
GEMINI_API_KEY=your_google_gemini_api_key
```

Web 版要使用酷狗时，需要自行部署 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 并填写 `VITE_KUGOU_API_BASE`。该变量没有默认公共实例；开发调试时可在 `.env.local` 中临时指向调试服务。Electron 版在主进程中直接调用内置的 KuGouMusicApi Node 模块，不会再启动一个酷狗 HTTP 服务。

Electron 的酷狗登录与账号刷新日志位于 `%APPDATA%\Folia\logs\kugou-provider.log`。日志只记录请求阶段、状态、字段名和错误摘要，token、Cookie、userid、dfid 会被脱敏。

OpenAI 兼容接口示例：

```env
VITE_NETEASE_API_BASE=http://localhost:3000
VITE_AI_PROVIDER=openai
OPENAI_API_KEY=your_api_key
OPENAI_API_URL=https://api.deepseek.com
OPENAI_API_MODEL=deepseek-v4-flash
OPENAI_API_TEMPERATURE=0.7
```

如果你使用的是 OpenAI 官方接口，也可以这样写：

```env
VITE_NETEASE_API_BASE=http://localhost:3000
VITE_AI_PROVIDER=openai
OPENAI_API_KEY=your_api_key
OPENAI_API_URL=https://api.openai.com/v1
OPENAI_API_MODEL=gpt-4o
OPENAI_API_TEMPERATURE=0.7
```

#### 3. 启动开发环境

```bash
vercel dev
```

## Android（Capacitor 8）

Android 应用位于仓库的 `android/`，内置 `dist/` 中的 Vite 产物；application ID 固定为 `top.izuna.foliamajor`，最低支持 Android 7 / API 24。Android 构建不会注册 PWA Service Worker，本地音乐入口因为不支持因此也会隐藏。

### 本地工具链

- 最新稳定版 Android Studio，并使用它自带的 JDK。
- Android SDK Platform 36.1、最新 Build Tools 36.x、Platform Tools。
- 模拟器建议使用 API 36.1 系统镜像。
- 工程固定使用 Capacitor 8 模板的 AGP 8.13.x 与 Gradle Wrapper 8.14.3。

首次准备：

```bash
npm ci --allow-remote=root
npm run cap:assets:android
npm run cap:sync:android
```

`cap:assets:android` 以 `android/img/icon.png`、`android/img/splash-light.png` 和 `android/img/splash-dark.png` 为唯一源图，重新生成 adaptive/round/legacy 图标及浅色、深色纵横屏启动图；源图不会被修改。

`build:capacitor` 不再内置任何 API 地址。若要在 Android 中使用 AI 主题或歌词代理，请在 `.env.local` 中提供自行托管的 HTTPS `VITE_FOLIA_API_BASE`；不配置时这些功能会在运行时提示不可用。Web 未配置时仍使用同源 `/api/*`。AI Key 只能配置在你的服务端，禁止放入 `VITE_*`、APK 或 Android 日志。

### 构建与运行

```bash
npm run cap:open:android
npm run cap:run:android
npm run build:android:debug
npm run build:android:bundle
```

- 调试 APK：`android/app/build/outputs/apk/debug/app-debug.apk`
- 发布 AAB：`android/app/build/outputs/bundle/release/app-release.aab`
- 每次 Web 代码变化后先执行 `npm run cap:sync:android`，确保 APK 内资源已更新。

### 发布签名

Android `versionName` 自动读取 `package.json`；`versionCode` 从 1 开始，每次发布到应用商店前必须严格递增。复制 `android/keystore.properties.example` 为 `android/keystore.properties`，填写本机 keystore 的相对路径、密码和 alias。真实 `keystore.properties`、`*.jks`、`*.keystore`、APK/AAB 与 Gradle 缓存均被 Git 忽略；缺少本地签名配置时仍可检查 unsigned release bundle。

首版只承诺前台播放，不包含本地音乐扫描、Android 前台媒体服务、可靠后台/锁屏连续播放或 Play 商店正式上架。Navidrome 服务必须使用 HTTPS。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 构建 Web 版本 |
| `npm run build:capacitor` | 构建不含 PWA Service Worker 的 Android Web 产物 |
| `npm run cap:assets:android` | 从 `android/img` 的三张源图重新生成 Android 图标和启动图 |
| `npm run cap:sync:android` | 构建 Web 产物并同步到 Android 工程 |
| `npm run cap:open:android` | 使用 Android Studio 打开 Android 工程 |
| `npm run cap:run:android` | 构建并运行到已连接设备或模拟器 |
| `npm run build:android:debug` | 同步资源并生成调试 APK |
| `npm run build:android:bundle` | 同步资源并生成发布 AAB |
| `npm run preview` | 预览构建结果 |
| `npm run dev:electron` | 启动 Electron 开发模式 |
| `npm run dev:electron:dist` | 构建后以桌面模式运行 |
| `npm run build:electron` | 打包桌面端应用 |
| `npm run stage:client` | 打开本地 Stage API 联调台 |

## 代码速查地图

| 需求 | 优先入口 |
| --- | --- |
| App 顶层装配、overlay、dialog、播放器面板参数组装 | `src/components/app/*` |
| 设置中心 UI | `src/components/modal/settings/*` |
| 设置持久化、visualizer tuning、偏好 store | `src/stores/useSettingsUiStore.ts` |
| 命令面板命令 | `src/components/command-palette/commandRegistry.ts` |
| visualizer 共享契约和注册 | `src/components/visualizer/definition.ts`、`src/components/visualizer/registry.tsx` |
| visualizer 预览和设置面板 | `src/components/visualizer/VisPlayground.tsx`、`src/components/visualizer/VisPlaygroundSettingsPanel.tsx` |
| visualizer 模式实现 | `src/components/visualizer/<mode>/*` |
| 歌词解析和渲染提示 | `src/utils/lyrics/*` |
| 本地音乐、Navidrome、网易云服务 | `src/services/*` |
| 共享类型和默认 tuning | `src/types.ts` |

新增设置时遵守项目 skill：视觉相关设置需要进入外观页的配置导入导出；功能性设置和可执行动作需要注册到 command palette。

## 技术栈

- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- React 19
- Vite 6
- TypeScript
- Tailwind CSS 4
- Framer Motion
- Electron
- i18next
