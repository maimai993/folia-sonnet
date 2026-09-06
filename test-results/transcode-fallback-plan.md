# Transcode fallback implementation log

## Goal

在 Electron 中，当本地歌曲或 Navidrome 歌曲的当前、仍有效的媒体元素音源确认发生解码/格式不支持错误时，使用独立 FFmpeg 任务生成 Chromium 可播放的完整文件，并把同一 playback/deck 原位切换到转码表示。Web 版本和其他来源保持现状。

## Safety and behavior constraints

- 仅处理 `local` 与 `navidrome` 来源，且仅在 Electron bridge 能力可用时启用。
- `MEDIA_ERR_ABORTED`、`MEDIA_ERR_NETWORK`、鉴权/文件访问错误、自动播放拒绝不触发转码。
- `MEDIA_ERR_DECODE` 可进入恢复；`MEDIA_ERR_SRC_NOT_SUPPORTED` 先交由主进程验证输入包含音频轨并可被 FFmpeg 严格解码。
- 转码输出优先 FLAC；能力或运行失败时只允许一次受控的 PCM WAV 保底，不递归转码输出。
- 整首转码完成并验证后才发布；FFmpeg 只接触主进程控制的本地路径。
- 恢复必须绑定 playback generation、deck、歌曲和原音源 URL；迟到任务可以留下缓存，但不得覆盖新播放。
- 保留当前歌曲、歌词、队列和统计身份；只替换对应 audio deck 的实际资源并恢复最新播放/seek 意图。
- 保留所有现有 `@note` 注释。

## Planned phases

1. 盘点现有 playback、deck、Electron IPC、FFmpeg resolver、本地 File handle 与 Navidrome URL 流程。
2. 新增共享类型与 renderer 侧媒体错误分类、恢复协调器。
3. 新增 Electron transcode service：受控输入、任务去重/取消、FFmpeg runner、完整文件缓存和协议读取。
4. 将本地 File 与 Navidrome 失败输入安全交给主进程，并接入 preload bridge。
5. 在双 audio/deck 错误入口原位恢复，确保 generation/deck 归属和播放意图正确。
6. 让 automix profile/stems 在存在转码表示时消费同一表示；补充状态清理。
7. 添加 Electron 默认开启的功能设置、命令入口和 i18n（若当前设置架构允许在不扩大范围的前提下完成）。
8. 添加 Vitest/Node 单测，执行 typecheck、相关单测与 Electron 静态/集成验证。

## Change log

### 2026-09-06 — initialization

- 创建本实施台账。
- 已读取项目 README 定位信息与 `readme-reference`、`codebase-navigation`、`testing-strategy`、`file-modularization`、`frontend-runtime-guardrails`、`reuse-project-utilities`、`settings-feature-integration` 规则。
- 确认开始前工作树干净；验证策略将优先使用相关 Vitest 与 typecheck，不默认执行完整 Electron 打包。

### 2026-09-06 — core transcode foundation

- 新增 renderer/main 共享恢复契约与纯媒体错误分类器；恢复输出使用歌曲身份、输入版本和 representation ID 分离歌曲与实际文件。
- 新增 Electron `transcode` 模块：严格 FFmpeg runner、FLAC 输出、仅在 FLAC 编码/封装能力缺失时使用 PCM WAV、二次完整解码验证、原子缓存发布和启动临时目录清理。
- 不同输入的 FFmpeg 作业在主进程串行执行，同一输入 revision 的请求共享任务；取消最后一个消费者会终止运行中或尚未开始的任务，避免多首恢复同时占满 CPU。
- 新增 `folia-transcode://` 安全协议，只接受 64 位十六进制缓存 key，支持 GET、HEAD、Range、206 与 416。
- 将协议加入唯一的 `registerSchemesAsPrivileged` 调用；新增转码请求/取消 IPC 与 preload 类型。
- 本地输入不允许 renderer 指定任意磁盘路径；通过现有 FileSystem handle 重新取得 `File` 后传输字节。Navidrome 输入由主进程下载，拒绝非 HTTP(S)、错误状态及 JSON/XML/HTML 响应，URL 不进入 FFmpeg 参数或日志。

### 2026-09-06 — playback and settings integration

- 新增 renderer `playableSourceService` 与 `useTranscodeFallback`：仅接管媒体元素 code 3/4、本地/Navidrome、Electron 能力存在且设置开启的错误。
- automix deck 记录 warm 歌曲归属，并提供 active/warm/tail 恢复目标；warm 转码不影响当前曲，tail 只进入 session 收尾，活动 deck 在转码前安全退出旧 transition。
- automix 后续预热会优先使用已注册的转码表示，避免 timeupdate 再次把 warm deck 覆盖回已经确认不可播放的原 URL。
- 本地/Navidrome 正式播放入口会在输入 revision 精确匹配时复用已恢复表示，保证 warm deck 移交到 active deck 时 URL 字符串稳定；文件大小/修改时间或 Navidrome 路径/流地址变化时不会复用旧表示。
- 活动 deck 恢复绑定当前 source 与 generation，保存播放位置和播放意图；切歌/换源会取消订阅并禁止迟到结果覆盖。恢复只替换 deck URL，不重置歌曲、歌词或队列。
- 转码完成时重新读取最新 seek 和暂停状态；恢复期间用户暂停后不会被迟到结果自动起播，恢复期间的新 seek 会覆盖最初错误位置。
- 收紧原本的本地尾部容错：现在只有真实 `MEDIA_ERR_DECODE` 且位于最后 3 秒时才视为自然结束。
- 添加 Electron 默认开启的播放设置、Electron 平台命令入口，以及英文、简体中文、印尼文 UI/状态文案。

### 2026-09-06 — initial tests

- 添加媒体错误分类单测，覆盖 code 1/2 排除、code 3/4 候选与转码输出禁止递归。
- 添加自定义协议 URL/Range 解析单测，覆盖封闭、开放、后缀范围和非法路径。
- 添加 FFmpeg 参数单测，锁定单音轨、禁视频/字幕/数据、48 kHz stereo FLAC、单一 PCM WAV 保底与完整输出验证。
- 更新 command palette 测试上下文以包含新的设置动作。

### 2026-09-06 — analysis representation alignment

- 新增内存 representation registry；转码恢复成功后以歌曲 key 注册实际播放表示。
- profile 与 stems 优先读取转码协议 URL，并把 representation ID 纳入内存和持久化分析 key；原始表示的 decode failure 不会阻止新表示重新分析。
- head/tail stems 通过同一 representation key 取数，避免原始文件与实际播放的 48 kHz stereo 时间/声道表示混用。
- Navidrome 若实际失败源是媒体缓存生成的 `blob:`，会转交该 blob 的实际字节；HTTP(S) 失败源才由主进程下载，避免错误地把 renderer-only URL 交给 FFmpeg 或恢复了不同表示。

### 2026-09-06 — validation pass 1

- `npm run typecheck` 在新增 command context 测试替身前准确发现缺失动作；补齐后继续验证。
- 相关 7 个测试文件共 107 项通过；command palette 的固定顺序快照已按新增命令更新。
- 全量 Vitest 共 3084 项中 3083 项通过、1 项跳过；唯一失败是新增 localStorage key 的预期快照差异，随后更新该契约快照。
- 使用本机 FFmpeg 5.1.2 对 24-bit PCM 测试音频执行真实 runner：成功生成 48 kHz stereo FLAC（90,739 bytes），完整二次解码及 0.75 秒 seek 验证通过。

### 2026-09-06 — final implementation audit

- Navidrome source revision 只保留 origin/path 与 `format`、`maxBitRate` 表示参数，不缓存用户名、token、salt 等鉴权查询字段；新增单测锁定该边界。
- 同一 source revision 的消费者共享转码作业；不同输入严格单并发，队列中的当前播放恢复优先于 warm 恢复。
- 本地播放入口按 `song id + size + lastModified` 精确复用表示；Navidrome 按媒体身份、路径、suffix、时长和无凭据流表示精确复用，版本变化会回到原音源并重新确认失败。
- 提交后最终复验：`npm run typecheck` 通过；CJS `node --check` 通过；全量 Vitest 331 个文件、3089 项通过、1 项按原配置跳过；新增恢复/协议/runner/service/revision 测试均通过。
- 未执行 Electron 完整打包：仓库验证策略要求 Electron 改动优先静态与最小集成验证，且当前仓库没有随包音频裁剪 FFmpeg 产物。运行时 resolver 已支持 `FOLIA_FFMPEG_PATH`、仓库 `ffmpeg-8.1.2/`、packaged `resources/ffmpeg/` 和系统 PATH；发布前仍需按目标平台放入并验证裁剪二进制。

### 2026-09-06 — manual fallback fixture

- 新增 `test-results/transcode-fallback-sample.wv`，作为 Electron 手工回归用的 WavPack 输入；文件包含 12 秒、48 kHz、单声道的 440 Hz/880 Hz 混合测试音并带首尾淡化。
- `ffprobe` 校验结果：`wavpack` 音轨、WavPack 容器、时长 12.000 秒、文件大小 1,252,984 bytes；SHA-256 为 `00A27F96F01D3F0CD917A23934A690643151847F64E8CD27C7C56F11F09DA190`。
- 该格式用于触发 Chromium `<audio>` 不支持输入时的转码恢复路径；将文件导入本地曲库或 Navidrome 后，在 Electron 版本中播放即可验证。

### 2026-09-06 — local import extension alignment

- 扩展本地目录扫描的音频后缀白名单，新增显式 ALAC（`.alac`）、APE（`.ape`）、WavPack（`.wv`）、TTA（`.tta`）、WMA（`.wma`）、AIFF（`.aif`/`.aiff`）与 CAF（`.caf`），避免 fallback 目标格式在导入快照阶段被过滤；常见的 ALAC `.m4a` 封装仍沿用原有支持。
- 文件名元数据解析改为复用同一音频后缀正则，新增格式不会把扩展名错误保留在歌曲标题中。
- 新增本地导入单测，验证上述八种后缀以 `application/octet-stream` MIME 仍会进入音频快照和歌曲导入，同时普通 `.txt` 文件继续被排除。

### 2026-09-07 — source sample-rate preservation and bundled binary validation

- runner 移除固定 `-ar 48000`，继续固定双声道但让 FFmpeg 沿用输入采样率；96 kHz 输入现在输出 96 kHz FLAC/WAV，普通 44.1/48 kHz 输入不发生无意义重采样。
- runner 参数单测改为锁定不存在 `-ar` 与 `48000`，防止后续重新引入固定采样率。
- 使用 `folia-ffmpeg-build` Windows x64 Folia 产物验证真实转码、完整输出解码、WavPack fallback、E-AC-3 (`ec-3`) in `.m4a` 与 96 kHz 保留；产物来源为 `test-results/ffmpeg-windows-x86_64-folia.zip`。
- 实测 96 kHz PCM 经 runner 输出 96 kHz/双声道 FLAC（114,044 bytes），WAV fallback 输出 96 kHz/双声道 PCM S16LE（384,102 bytes）；E-AC-3 `.m4a` 输出 48 kHz/双声道 FLAC（62,641 bytes），12 秒 WavPack fixture 输出 48 kHz/双声道 FLAC（598,943 bytes），所有输出均通过 runner 的完整二次解码。
- 最小验证通过：`transcodeRunner.test.ts` 3 项、`node --check electron/transcode/runner.cjs`、`npm run typecheck`。
