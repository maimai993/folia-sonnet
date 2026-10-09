# Folia-Sonnet 

这是将 Folia 打包到 Android 平台的实验性项目，不是官方 Android 客户端，也不代表 Folia 主项目的移动端计划。本仓库版本基于 Folia-major 0.7.13 正式版，请按照下面的说明自行构建。**仓库 Releases 中附带的是演示安装包，不建议直接当作日常客户端使用 —— 请先配置好你自己的后端服务再使用。**

> [!WARNING]
> 本仓库仅作为安卓端打包示范，不会继续维护并同步 Folia-major 主仓库的更新。功能、兼容性、构建链均可能随时失效；请自行 fork、审计并维护你的副本。

> [!IMPORTANT]
> **关于演示安装包**
>
> Releases 里附带的 APK 是**演示包**，只用来展示界面与前台播放体验：
>
> - **没有内置在线音乐后端**，在线搜索、歌词、封面、AI 主题等功能在未配置服务器时不可用；
> - 不会随主仓库更新，也不保证兼容性与后续维护；
> - **不建议直接日常使用**。
>
> 请按下方「Android 构建」一节先部署并配置后端服务（`VITE_NETEASE_API_BASE`、
> `VITE_KUGOU_API_BASE`、`VITE_FOLIA_API_BASE`），再构建属于你自己的安装包。

## 范围与限制

此安卓构建不包含内置的在线音乐后端，你需要按照 web 版本部署的方案自行部署后端服务。

- Android 容器基于 Capacitor，主要用于验证 Folia 的界面与前台播放体验。
- 不承诺本地音乐扫描、后台/锁屏连续播放、Android 前台媒体服务或应用商店发布支持。
- 在线音乐、歌词、封面及其他第三方内容的版权归相应权利人所有。请遵守所在地法律及服务条款，并通过官方渠道支持正版内容。

## Android 构建

准备 Node.js 20+、JDK 17、Android Studio 以及 Android SDK 后：

```bash
npm ci
```

复制 `.env.example` 为 `.env.local`，按需部署对应的后端服务：

- `VITE_NETEASE_API_BASE`：网易云 API 实例。
- `VITE_KUGOU_API_BASE`：Web 版 KuGouMusicApi 实例。
- `VITE_FOLIA_API_BASE`：AI 主题或歌词代理所需的 HTTPS API 根地址。

前两者可以参考主仓库 web 版本的部署方法。`VITE_FOLIA_API_BASE` 的部署方法见下文

Windows 构建调试 APK：

```bash
npm run build:android:debug
```

macOS/Linux：

```bash
npm run cap:sync:android
cd android
./gradlew assembleDebug
```

输出文件：`android/app/build/outputs/apk/debug/app-debug.apk`。

如果跳过上面的后端配置直接构建，产出的就是等同于 Releases 中**演示包**的版本：可以安装、可以看界面与本地播放，但在线功能不可用 —— 这正是它不建议直接日常使用的原因。

发布 AAB、签名和完整工具链说明见 [技术与开发说明](docs/technical.md#android--capacitor)。

## 部署 Folia API 到 Vercel

`VITE_FOLIA_API_BASE` 指向本仓库的 Vercel Serverless API，用于 AI 主题生成和歌词代理。部署步骤：

1. 将此仓库 fork 到你的 GitHub 账号，在 Vercel 中选择 **Add New → Project** 并导入该 fork；保留仓库中的 `vercel.json` 默认构建配置。
2. 在 Vercel 项目的 **Settings → Environment Variables** 中配置一种 AI 提供商：
   - Gemini：`GEMINI_API_KEY`。
   - OpenAI 兼容服务：`OPENAI_API_KEY`、`OPENAI_API_URL` 和 `OPENAI_API_MODEL`；可选 `OPENAI_API_TEMPERATURE`。
3. 部署完成后，将 Android 本地 `.env.local` 中的值设为：

   ```env
   VITE_FOLIA_API_BASE=https://你的-vercel-项目.vercel.app/api
   ```

4. 重新执行 `npm run build:android:debug`。

密钥只应填写在 Vercel 环境变量中，绝不能写入 `.env.local`、`VITE_*` 或 APK。该 API 为跨域客户端设计，部署者应自行承担访问控制、配额与费用风险；不要为没有限额或滥用防护的高额度密钥公开部署。

## 许可证

本项目采用 [AGPL-3.0](LICENSE) 许可证。使用、修改或分发前请阅读许可证全文。
