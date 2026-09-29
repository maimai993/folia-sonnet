# 波点音乐桌面接入

波点使用独立的 `bodian` provider。普通前端调用通过 Omni，`bodianTransport` 仅向 Electron 的
`bodian-api-request` 发送已登记的操作。主进程负责平台请求、签名、设备标识和会话加密。
Web 端显示为运行环境不可用；没有默认外部代理服务。

## 当前实现与验收状态

| 能力 | 状态 |
| --- | --- |
| 平台入口、IPC 搜索、歌曲详情 | 已实现；Windows Electron 搜索已实测 |
| 公开歌单、专辑、歌手、推荐 | 已实现；对应原生读取接口已实测 |
| Discover 系统歌单 | 已接入现有推荐列表；潮趣日推、新歌大赏、华文流行极致、欧西流行宇宙均已验证返回 30 首 |
| 逐字歌词 | 已实现；真实响应解码与合成时间样例测试通过 |
| 扫码登录 | 已修正为 `authType: 10`；三次新扫码均精确匹配用户独立提供的账号 ID |
| 会话恢复、个人歌单、我喜欢、收藏专辑 | V2 加密会话恢复后已读到自建歌单及喜欢歌曲；收藏歌单/专辑的空列表已验证，非空列表待验收 |
| 播放权限与音频地址 | 试听与完整音源均已验证；Electron + Omni 获取 320 kbps MP3，Chromium 解码并推进播放，时长约 269.7 秒 |
| 歌单歌曲增删 | 已实现；专用空歌单真实添加、读取确认、删除并恢复原状通过 |
| 喜欢/取消喜欢 | 已实现；经用户追加授权，真实喜欢、读取确认、取消后核对原有 3 首不变 |
| 收藏/取消收藏歌单或专辑 | 未实现；缺少已验证的写入协议，相关方法不提供 |
| Web、短信登录 | 本期不包含 |

这份实现尚未达到“完整平台接入”的验收标准。不要把单元测试中的账号样例当作真实曲库验收。
后续必须使用用户新扫码建立的会话，不读取官方客户端已有凭据。

## 已核对的协议

API 主站为 `https://bd-api.kuwo.cn`。桌面头包含 `plat=win`、`channel=W1`、`ver=1.1.7`、
`svrver=13`、`devid`、`qimei36`。缺少必要头时搜索可能返回业务码 `402`。

| 操作 | 路径/重要参数 |
| --- | --- |
| 搜索 | `/api/search/music/list`，`keyword/pn/rn`；页号从 0 开始 |
| 单曲 | `/api/service/music/info`，`musicId` |
| 创建二维码 | `/api/ucenter/login/qrCode`，响应 `data.qrCode` |
| 扫码轮询 | `/api/ucenter/login/qrCodeStatus`，`qrCode`；已观察 1 等待、2 过期、3 已扫码确认 |
| 换取新会话 | POST `/api/ucenter/users/login`，JSON `{authType: 10, qrCode}`；旧类型 9 的错配会话不得恢复 |
| 播放权限 | `/api/play/music/v2/checkRight`，`musicId/freeSign`，签名与 JSON body |
| 音频地址 | `/api/play/music/v2/audioUrl`，`devId/musicId/format/br/freeSign`，签名与 JSON body |
| 公开歌单详情 | `/api/service/playlist/info/{id}`，保留 `source` |
| 歌单曲目 | `/api/service/playlist/{id}/musicList`，`source/pn/rn`；页号从 1 开始 |
| 我喜欢的歌单 | `/api/service/playlist/fond`，`userId`；曲目来源为 5 |
| 自建歌单 | `/api/service/playlist/userCreate`，`userId` |
| 收藏歌单 | `/api/service/collect/4/list`，`userId/fromUid/pn/rn` |
| 收藏专辑 | `/api/service/collect/6/list`；新会话空列表已验证。7 的真实返回是 `artistList`，不能用作专辑 |
| 歌单歌曲增删 | POST `/api/service/playlist/music` 或 `/api/service/playlist/music/delete`；签名 JSON `{playListId, musicIdList}` |
| 专辑及曲目 | `/api/service/album/{id}`、`/api/service/album/music/{id}` |
| 歌手及曲目/专辑 | `/api/service/artist/{id}`、`/api/service/artist/music/{id}`、`/api/service/artist/album/{id}` |
| 推荐 | `/api/service/finds/playlist`、`/api/service/music/recommendList` |
| Discover | `/api/service/home/module?moduleId=1` 获取卡片，`/api/service/home/aiPlaylistDetail?index=N` 获取完整歌曲 |

二维码内容必须为：

```text
https://bodian-oia.kuwo.cn/bodian/download.html?pageName=login_pc&pt=3&id=<qrCode>
```

二维码标识本身、`login_pc?qrCode=...` 都不能作为扫码内容。联调截图应使用不同文件名，避免展示端缓存旧图片。

2026-09-20 撤回“扫码认证类型 9 已验证成功”的结论。HTTP/业务成功与返回 token 不证明扫码身份绑定。
`userCreate` 在匿名对照请求中同样返回空列表，不能作为登录有效性检查；公开资料也不能证明认证。
身份错配根因尚未确定，不把它归咎于用户账号或上游漏洞。需要核实扫码结果与交换参数的真实关联。

2026-09-22 公开源码调查发现：
[PyBodian 的扫码修复](https://github.com/MoeclubM/PyBodian/commit/79ed7e25234efa07f4a5445ca10fdf06acedba0d)
在 `login_by_qr_code` 中使用 `{authType: 10, qrCode}`，并把 `authType: 9` 用于另一条 QQ 授权流程。
这是第三方实现线索，不是官方协议证明；不得据此宣告身份错配根因已确定。
后续隔离验证应先由用户从官方 App 提供预期账号 ID，交换结果只在内存中与该 ID 精确比较，
不匹配时停止，不读取曲库或保存会话。账号功能恢复仍需完成身份与会话有效性验证。

随后两次独立新扫码交换均使用 `authType: 10`，返回 ID 与用户从官方 App 提供的预期 ID
精确匹配，用户也确认了扫码。两次内存凭据均已销毁，未读取曲库。新的身份验证器有离线
回归覆盖身份冲突、不匹配、超时、取消与重复轮询；这不代表会话恢复和曲库已验收。
第二次检查 GET `/api/ucenter/users/login` 时遇到 HTTP 500，匿名带签名对照同样为 500；
该 GET 路径不是可用的会话验证依据。`login_status` 返回新扫码形成的 V2 本地会话身份；
它不宣称实时远端鉴权。实际账号请求收到 `auth-required` 时清除主进程会话，前端随后清空账号快照。

经用户同意，验收时仅将新扫码且身份匹配的会话以 `safeStorage` 加密保存到独立的测试 profile。
验收工具不访问官方客户端配置；恢复结果仅证明本地解密，不证明远端会话有效。恢复后已实际
读取账号曲库、获取并播放完整音源。写入验收只允许唯一名称匹配的自建测试歌单，并在添加后
删除测试歌曲、核对原始成员集合。相关扫码、抓包和人工验收工具不随功能 PR 提交。

主进程现在只恢复 `BODIAN_SESSION_V2`；初始化删除 `BODIAN_SESSION_V1`，不解密、不迁移旧会话。
前端启动时不再读取历史波点账号快照；账号能力关闭或环境不可用时清空可见账号与快照，
本地缓存清理失败也不恢复旧身份。曲库必须从当前会话重新读取；不会从历史界面缓存宣告登录。
主进程对歌单增删核对当前用户的自建歌单列表，并拒绝账号切换后晚到的写入。

## 歌词、音频与缓存

- 歌词来自 `https://mlyric.kuwo.cn/mobi.s?f=bodian`；参数 `q` 为歌词请求的 Base64，响应 `data.content`
  也是 Base64。`[kuwo:...]` 的八进制数编码逐字时间系数，先还原，再交给现有 `parseAwlrc`。
- 已验证 `[kuwo:127]` 对应系数 8、7：标记 `<a,b>` 的偏移为 `abs((a+b)/16)`，时长为 `abs((a-b)/14)`。
  系数从文件读取，不固定写死；无有效逐字轨时回退到行歌词。
- 权限状态 3 返回试听信息；7 表示当前请求还缺少播放权限。试听不会写入完整歌曲的音频缓存，界面显示对应提示。
- 音质映射为 128k MP3、320k MP3、FLAC。Hi-Res 请求暂降至普通 FLAC，并返回实际选择的质量标识。
- 歌曲身份保留 `online:bodian:<id>`。歌单的 `source` 保留在 `providerData` 中；不以 `hasNextPage=false`
  单独判断结束，因为真实歌单响应中的 PageHelper 标志可能不正确。
- 自建歌单响应缺少 `sourceType`，必须按来源 5 读取曲目；公开集合默认来源仍为 4。
- 部分服务端分页会省略歌曲：真实公开歌单标称 121 首，第一页只返回 99 首，第二页返回 21 首。
  主进程提供按请求页边界推进的游标，前端不能用返回数量 99 作为下一页偏移；已实际验证两页取回
  上游提供的 120 个不同歌曲 ID。未返回的 1 首不能补造，也不计作已获取。
- 凭据只在主进程持有，并通过 Electron `safeStorage` 加密。系统加密不可用时，仅保留本次运行的会话。

## 验证方式与剩余工作

使用 Node 24 以上和项目锁文件安装依赖。执行类型检查、`test/unit/onlineMusic/`、
`test/unit/lyrics/bodianLyrics.test.ts`、`test/unit/electron/bodianApiBridge.test.ts` 以及相关播放回归测试。

真实账号联调应使用独立的 Electron profile，不读取官方客户端凭据，也不修改用户正常的 Folia 配置。
账号 ID、真实歌单 ID、凭据和音频地址不得写入仓库；`test-results` 不得提交。
仓库中的自动化覆盖集中在 `test/unit/`；抓包、扫码和桌面人工验收脚本属于开发者本地工具，不随功能 PR 提交。

剩余工作：收藏写入协议与实现、非空收藏专辑的真实验收、完整 UI 操作回归。
没有对应已验证协议的收藏方法保持缺省，不把 `mutations: true` 当作所有写入均可用的证明。

### 收藏协议调查的当前阻塞（2026-09-22）

用户完成了一轮官方客户端新扫码及收藏/取消收藏操作，但进程范围抓取没有生成符合筛选条件的
收藏脱敏记录；无法据此断言流量曾进入代理，也未取得收藏请求方式和参数。不要重复猜测写入协议。
本机命令环境的证书查询与桌面证书管理器存在差异：用户重新打开管理器后仍可见证书，且截图
指纹与本项目 CA 完全一致，而命令环境仍查询不到。此前“命令查不到即导入未保存”的判断不成立，
差异原因尚未确定；不得仅凭命令查询为空宣告桌面证书已清理。
该轮抓取进程已停止并核实退出，用户随后在证书管理器手动删除临时证书并确认完成。
继续收藏接入需要可核验的协议资料或能实际产出脱敏记录的调试环境；不自动恢复抓取或重复要求扫码。
