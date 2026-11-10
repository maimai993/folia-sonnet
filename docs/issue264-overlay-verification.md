# #264 Android 叠层动画周期回抽验证

## 范围与原因

复现流程：播放歌曲 → 开启「在所有应用上叠加」→ 切换花火 → 返回系统主页观察。与背景运行哪个第三方应用无关。

旧包中，叠层每三秒核对显示状态，读取的是原生播放器的缓存位置；后台位置采样间隔为一秒，因此该缓存不是核对时刻的位置。现场日志观测到主线程约三秒一次 `lyrics anchor jumped`，幅度约 -600～-1100ms；CDP 同时记录到歌词和主题内容不变的位置包发生回退。

本次改为在播放器 looper 读取实时位置，不调整原有 250ms 容差，也不禁止合法 seek。控制动作期间用 epoch/pending 保护异步校准；prepare、seek、crossfade 仍按原队列执行，不能为了显示采样丢弃控制命令。相同内容的主题和歌词包保留引用，避免时钟包额外触发可视化内容重建。

## 最终分支验证

- 基点：`209321b82073d122d8795ba8379acee469b63133`（dev）。
- 分支：`fix/issue264-overlay-stutter`，不夹带旧工作树的 #269 等提交。
- 应用版本：0.7.27.5；未手动更改版本号。
- 设备：LDPlayer14，Android 14，540×960，240 DPI；模拟器，非实体手机。请求人明确指定以雷电作为本轮装置验收标准。
- 完整 `cap:sync:android`，Android 单元测试及 `assembleRelease` 成功；release 产物未签名，覆盖安装验收使用同源码 debug 包。
- 最终 debug APK SHA256：`FDA6A4542F76620053BA969A6A3DC9AFF379E1EA2E4C1F9409BDCD7ACC6124AB`。
- 确认持久化配置 `visualizer_mode=hanabi`、`folia.wallpaperOverlayAllApps=true`；起播后返回雷电主页，录制 20.035567 秒原始 screenrecord，抽帧确认有花火歌词、装饰、镜头切换及可透出的系统主页，不是启动截图。
- 原始录屏保留本地供人工验收，不将含用户数据的历史 CDP 输出、日志、账号页面或整个 artifacts 目录提交到仓库。

## 自动检查

- UI 控件、文件大小、版本、源码密钥扫描、前端 typecheck、sync-server build:node：通过。
- 完整 Web 单元测试：15,677 通过，8 跳过；唯一失败为 `modSignature.test.ts` 在 Windows 创建 symlink 的 EPERM。按 AGENTS.md/ci/README.md 的已知平台例外记录，不放宽测试。
- 因上述单测例外 `ci:local` 在单测阶段退出；随后单独执行剩余 `npm run build` 与产物密钥扫描，均通过，不把原始命令 exit code 写成 0。
- Android：24 suites，177 tests，0 failures，0 errors。
- `git diff --check`：通过。
- 第一轮独立只读审查：未发现成立的高/中问题。审查报告在 PR Reviews 发布。

## 证据边界

此前候选包的一次 20 秒 CDP 窗口没有位置推送回退，但仍存在单个较长 RAF 间隔；不能据此宣称所有 WebView/GPU 丢帧消失。旧报告的累计 gfxinfo 9.97% 不是独立录制窗口掉帧率；模拟器 GPU 统计约 1ms 也不能排除 WebGL/宿主合成瓶颈。本 PR 只修复已经定位的陈旧位置校准和内容引用不稳定，不以修改帧率、删装饰或调大锚点容差掩盖其他性能问题。

人工验收请继续关注正常速度下的回抽、停留及镜头切换；本 PR 不自动关闭 #264，也不自动合并。
