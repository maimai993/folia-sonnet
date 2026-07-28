# Folia Web Docker 部署

当前目录提供面向 Docker 部署的完整 Web 堆栈：前端网关、Folia Web API、在线音乐接口和独立的 Sync Server。对外只发布 Web 网关与 Sync Server 两个端口，其余服务仅通过 Docker 网络互访。

## 快速启动

要求 Docker Engine 24+ 与 Docker Compose v2。复制环境变量模板：

```bash
cd deploy/docker
cp .env.example .env
```

至少填写：

```env
FOLIA_IMAGE_NAMESPACE=镜像发布者的_Docker_Hub_用户名
SYNC_TOKEN=至少八位的随机字符串
```
Folia 官方仓库的 Docker Hub 镜像命名空间为 `papersman`，可直接使用官方镜像。自建镜像请在 `.env` 中指定自己的命名空间。

按需填写 Gemini 或 OpenAI 兼容服务配置，然后启动：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

默认地址：

- Web：`http://NAS-IP:18080`
- Sync Server：`http://NAS-IP:13000/health`

网易云、酷狗和 Folia Web API 没有宿主机端口，不能绕过 gateway 直接访问。Sync Server 位于独立网络，不与 Web 内部服务互通。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FOLIA_IMAGE_NAMESPACE` | 无 | Docker Hub 镜像命名空间，必填 |
| `FOLIA_STACK_VERSION` | `latest` | 四个 Web 堆栈镜像的统一版本 |
| `FOLIA_SYNC_VERSION` | `latest` | Sync Server 独立版本 |
| `FOLIA_HTTP_BIND` / `FOLIA_HTTP_PORT` | `0.0.0.0` / `18080` | Web 网关监听 |
| `FOLIA_AI_PROVIDER` | `google` | `google`、`gemini` 或 `openai` |
| `FOLIA_FORWARD_CLIENT_IP` | `false` | 是否把浏览器 IP 转发给音乐平台；保持 `false` 可避免 LAN/Docker 地址出现在登录地点 |
| `ENABLE_GENERAL_UNBLOCK` | `false` | 网易云 API 通用解锁开关；默认关闭 |
| `FOLIA_SYNC_BIND` / `FOLIA_SYNC_PORT` | `0.0.0.0` / `13000` | Sync Server 监听 |
| `FOLIA_SYNC_DATA_DIR` | `./data/sync` | SQLite 持久化目录 |
| `SYNC_TOKEN` | 无 | Sync 客户端 Bearer Token，至少八位，必填 |
| `DASHBOARD_TOKEN` | 空 | Sync Server 隐藏看板 Token |

AI 密钥只传给 backend 容器，不会写入前端静态文件。修改 `FOLIA_AI_PROVIDER` 后重建 gateway 容器即可，不需要重新构建镜像：

```bash
docker compose up -d --force-recreate gateway
```

网易云和酷狗镜像默认不把浏览器或 Docker 私网地址写入上游请求，音乐平台会根据连接本身识别 NAS 的公网出口。只有兼容旧部署行为时才应设置 `FOLIA_FORWARD_CLIENT_IP=true`；这可能使登录记录显示为“局域网”或“未知”。

## HTTPS 与浏览器安全上下文

`http://NAS-IP:18080` 可以使用在线搜索、播放、歌词与大部分可视化，但局域网 IP 上的普通 HTTP 不属于浏览器安全上下文。以下能力会不可用或降级：

- File System Access API：本地音乐目录导入、重扫和恢复授权不可用。
- Service Worker / PWA：不能可靠安装或离线运行。
- OPFS：封面二进制持久缓存降级。
- 音频设备枚举和输出设备选择不可用。
- 标准 Clipboard API 不可用，只有实现旧式回退的复制入口仍可能工作。

HTTP 与 HTTPS 是不同 origin。改用 HTTPS 后，HTTP 下的 IndexedDB、登录态、设置和本地曲库索引不会自动迁移。

正式使用本地音乐时，推荐让 NAS 现有反向代理终止 HTTPS：

```text
https://folia.example.com/  ->  http://127.0.0.1:18080
https://sync.example.com/   ->  http://127.0.0.1:13000
```

证书必须具有浏览器信任的完整合法证书链。未在客户端安装根证书的自签名证书仍不属于可信安全上下文。建议使用独立根域/子域，不支持将应用挂载在 `/folia/` 子路径。

反向代理应传递：

```text
Host
X-Forwarded-Host
X-Forwarded-Proto: https
X-Forwarded-For
```

同时把 HTTP 请求重定向到 HTTPS。反向代理在 NAS 宿主机运行时，可将 `FOLIA_HTTP_BIND` 和 `FOLIA_SYNC_BIND` 改为 `127.0.0.1`，避免绕过代理；若反向代理本身位于 Docker，请按 NAS 平台要求连接代理网络或通过受防火墙保护的宿主机端口访问。

File System Access API 还取决于浏览器支持；当前应使用桌面版 Chromium 系浏览器。HTTPS 本身不会让 Firefox 或不支持该 API 的 Safari 获得目录选择能力。

## 更新、回滚和维护

更新到 `.env` 指定版本：

```bash
docker compose pull
docker compose up -d
```

回滚时把 `FOLIA_STACK_VERSION` 或 `FOLIA_SYNC_VERSION` 改为先前的 `A.B.C` 标签，再重复以上命令。生产部署应固定版本，不要依赖 `latest`。

数据库位于 `FOLIA_SYNC_DATA_DIR`。备份前可停止 Sync Server：

```bash
docker compose stop sync-server
tar -czf folia-sync-backup.tar.gz ./data/sync
docker compose start sync-server
```

常用诊断：

```bash
docker compose ps
docker compose logs --tail=200 gateway backend netease-api kugou-api sync-server
curl http://127.0.0.1:18080/healthz
curl http://127.0.0.1:18080/api/healthz
curl http://127.0.0.1:13000/health
```

若只开发或运行 Sync Server，可在仓库根目录执行：

```bash
docker compose -f deploy/docker/compose.sync.yaml up -d --build
```

## 本地镜像验证

```bash
FOLIA_IMAGE_NAMESPACE=folia-local SYNC_TOKEN=docker-check-token \
  docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.build.yaml config

docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.build.yaml build
./deploy/docker/scripts/smoke-test.sh
```
