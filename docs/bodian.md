# 波点音乐桌面接入

波点使用独立的 `bodian` provider。普通在线操作经过 Omni；renderer 通过受限 IPC 调用主进程，
主进程使用固定版本的 [`bodian-music-api@0.1.0`](https://www.npmjs.com/package/bodian-music-api)。
协议代码、请求签名、接口参数、分页游标和专用歌词解码在
[独立仓库](https://github.com/Mintcolour/bodian-music-api) 维护。

## 仓库边界

- 独立包：HTTP 客户端、平台请求头和签名、扫码、目录、播放权限、曲库、写入与歌词解码。
- Folia 主进程：IPC 操作和参数校验、可信窗口检查、设备标识持久化、系统加密存储及音频 CORS。
- Folia renderer：Omni adapter、平台数据归一化、通用歌词解析、缓存、队列与现有界面。

包直接在 Electron 主进程运行，不启动 HTTP 服务或新增端口。Folia 注入 Electron `net.request`，
以保留桌面网络行为。运行时的 Node 包不得从 renderer 导入；共享协议类型通过 `import type` 使用。

## 能力与限制

支持扫码登录、会话恢复、搜索、歌曲/歌单/专辑/歌手、播放、逐字歌词、个人歌单、喜欢/取消喜欢
以及自建歌单歌曲增删。Discover 的潮趣日推、新歌大赏、华文流行极致、欧西流行宇宙使用现有推荐
列表展示；完整曲目由独立包读取，单个推荐失败不阻断其他推荐。

收藏/取消收藏歌单和专辑的写入尚未实现；Web 与短信登录不支持。收藏列表的空结果曾完成验收，
非空收藏专辑仍需手动验证。Hi-Res 当前回退普通 FLAC；试听不会作为完整歌曲进入缓存。

## 会话与升级

沿用 `BODIAN_SESSION_V2` 和 `BODIAN_DEVICE_ID`，保持原有 Folia profile 和存储格式。
旧 V1 会话继续删除，不解密或迁移。拆包不会主动清空 V2 会话；实际鉴权仍由平台决定。
系统加密不可用或 Linux 选择 `basic_text` 时，仅保留本次运行会话。凭据不返回 renderer。
`login_status` 只表示恢复的本地身份；账号接口拒绝鉴权后由包清理当前会话，迟到的旧请求不清除新账号。

协议变更在独立仓库修复并发布新版本，Folia 通过明确的依赖升级和回归测试接入。版本必须固定，
锁文件使用 npm Registry 的版本与完整性信息，不提交本地 tarball、`file:` 或分支引用。

## 验证

使用 Node 24，按锁文件执行 `npm ci`。Folia 保留 IPC、V2 加密恢复、Omni、歌词适配和分页集成测试；
HTTP、签名、扫码与写入协议单测在独立仓库运行。分页必须使用 `nextOffset`，不能用可见条数推算：
稀疏首页返回 99 首时仍应从 100 继续，完成缓存保留 `hasMore=false`。

打包时核对独立包及其 `qrcode` 依赖已进入产物。真实账号和图形界面由用户手动验收，
不把 Node 单测通过视为跨平台桌面验收完成。账号、会话、签名音频地址和证书不写入仓库。
