# Issue #106：Android 唤醒状态认领

关联：https://github.com/maimai993/folia-sonnet/issues/106

## 维护者的验收标准

- 原生是播放真源。Web 唤醒只读原生队列、当前歌曲、进度与播放/暂停状态，不发起切歌覆盖原生。
- 唤醒时原生歌词、媒体通知与真实播放器重新对齐。
- 一个修复只处理一个主题，不混入版本、依赖或无关重构。
- 按 CONTRIBUTING.md，工具测试不能代替提交者的人工核验；不自动发起 PR、不自动合并。

## 根因与改动

- 旧恢复拉取与 Web metadata/queue/state effects 并行；认领回调丢弃 playing，并可能走 playSong 再装源。
- 原生自动前进与 Web 的 ended/next 都能推进队列，唤醒后迟到事件可能重复切歌。
- Web 引擎时钟不采纳原生快照，正确 motion signal 下一帧又被旧基线覆盖。
- 原生一次性 metadata 守卫无法保护后续旧游标/状态；原生歌词只发一次，Web 错过后不能恢复。

本修复先关闭恢复期回写，再串行读完整快照、重置本地时钟并认领队列。快照读取时若用户发起新播放，以用户意图为先。不再把原生 ended 再解释成 Web skip。原生按实际媒体身份拒绝旧 metadata/游标，读取快照前重建媒体通知；保存当前歌词与显式无歌词结果，旧异步歌词不得覆盖新歌。

## 验证记录

基线：dev `fd73e486`；分支：`fix/android-wake-native-authority`。

- 聚焦播放/恢复/契约测试已执行，新增时钟、队列身份、暂停/零进度、唤醒串行化、卸载与用户意图竞态回归。
- 最终聚焦回归：5 文件、81 项全部通过。包含后续审查修正与 QQ/local/Navidrome 身份重建回归。
- 最终全量：12632 项，12629 通过、1 失败、2 跳过。唯一失败为 modSignature 符号链接用例 Windows EPERM，未修改 `fd73e486` 对照中同样失败。
- 早期全量额外出现 library layerBoundaries 同名用例 STACK_TRACE_ERROR，未修改基线也重现；最终全量该项通过，属于本次观察到的波动，不声称修复了无关测试。未修改测试规避门禁。
- Android JVM 测试与 debug APK 编译通过；原生测试 61 项（含 12 项新准入/歌词缓存测试）。
- TypeScript、UI/体积、版本、源码密钥检查与 Capacitor Web 构建已运行；最终检查结果以交接摘要为准。
- 契约提取已运行，已有 manifest 无差异。Android getQueueState 增加可选 nativeMedia、lyrics；旧接口保留。

## 雷电实际运行验证

只启动 `Folia-Issue106-isolated` 一个实例（Android 14）。原实例仅作为克隆来源，原数据未改。旧安装签名与本机 debug 不同，只在隔离副本重装，未清理原实例数据。

使用本机合成 WAV，不登录、不调用真实账号：

1. 前台播放 A，退到桌面。
2. 原生桥在后台把队列切到 B。
3. 唤醒真实 Capacitor WebView，比较真实引擎、服务快照与页面 store。
4. 检查唤醒桥调用记录，不出现 prepare/seek/play/pause/stop/requestSkip/playFromQueue。
5. 后台暂停后唤醒，确认引擎与页面均保持暂停。

最终重新编译安装后，以上五项再次全部通过，进度未归零。系统 dumpsys media_session 显示 B 与 PAUSED，非旧 A。

追加验证：WebView reload 后仍认领 B、PAUSED、原生 B URL、位置 3415ms 与 A/B/C 队列；手动注入旧 A metadata、index=0、playing=true/80000ms 的陈旧写入后，原生仍是 B、index=1、PAUSED、3415ms；随后显式 requestSkip(+1) 成功，真实引擎与界面均为 C/PLAYING。以上均在隔离副本、合成音频中完成。

测试不是黑盒人工点击全流程：合成队列通过 CDP 写入页面 store，后台换歌通过真实原生插件调用。它验证真实桥/ExoPlayer/Activity 唤醒，但不等同真人使用在线歌单、真实帐号、数小时 Doze 或厂商冻结。

## 尚需人工验证

- ColorOS 16+ 真机锁屏/AOD 原生歌词与翻译；雷电不是 ColorOS，不能声称已实测。
- 真实 Lyricon 服务、长时间息屏/Doze、蓝牙耳机及真实在线音源。
- 本地音乐与 Navidrome 真实目录、WebView 被系统回收的完整恢复交互。
- 提交者审阅最终 diff、核验审查结论并亲自确认上述行为后，才考虑人工创建 PR（Closes #106，目标 dev）。

交付为个人 fork 的修复分支，供提交者审阅；不自动创建 PR 或合并，未发布 APK。测试 APK 仅用于隔离模拟器，不是正式签名升级包。
