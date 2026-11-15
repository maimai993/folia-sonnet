import { serve } from '@hono/node-server';
import { D1Emulator } from './d1-emulator.js';
import app from './app.js';
import { readAdminCredentials } from './admin.js';
import { pruneHitLog } from './aiCache.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { createNodeFontBlobStore } from './fontBlobs.node.js';
import { createD1FontBlobStore } from './fontBlobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Try to load basic .env file if it exists
try {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf-8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    }
  }
} catch (e) {
  // Ignore
}

const SYNC_TOKEN = process.env.SYNC_TOKEN;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
// Missing credentials disable the panel without disabling public/sync routes.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PUBLIC_ORIGIN = process.env.ADMIN_PUBLIC_ORIGIN;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

/*
 * 开几个进程。
 *
 * `better-sqlite3` 是**同步**驱动：一个进程只有一个连接、也只占一个核，一条慢 SQL
 * 就把那个进程的事件循环占住，所有请求在同一个线程里排队。多开进程是在 Node 侧
 * 吃满多核最直接的办法 —— 每个进程各连同一个库（WAL + busy_timeout），读请求完全并行。
 *
 * 取值规则：
 *  · `SYNC_SERVER_CLUSTER_WORKERS=0` → 单进程，保持老行为；
 *  · `SYNC_SERVER_CLUSTER_WORKERS=N` → 明确要 N 个（上限 64）；
 *  · 不填 → 自动：核数 - 1（给系统和其他活留一个核），单核机器退回单进程。
 *
 * 自动值封顶，因为每个进程各有一份 SQLite 页缓存（64MB）和 JS 堆，光有核数没有内存
 * 也会被 OOM 打死。想再多就显式写数字。
 */
const AUTO_WORKER_CAP = 4;
const readWorkerCount = (): number => {
  const raw = process.env.SYNC_SERVER_CLUSTER_WORKERS;
  const explicit = raw === undefined || raw.trim() === '' ? NaN : parseInt(raw, 10);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(64, explicit));
  /*
   * `availableParallelism()` 会考虑 cgroup 配额和 CPU 亲和性，比 `os.cpus().length`
   * 更贴近「这个容器/进程实际能用几个核」。老 Node 没有它时退回 cpus()。
   */
  const cores = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  if (!Number.isFinite(cores) || cores <= 1) return 0;
  return Math.min(AUTO_WORKER_CAP, cores - 1);
};
const CLUSTER_WORKERS = readWorkerCount();

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../folia-sync.db');
// 字体字节默认挨着数据库文件放：整机迁移时只要带着这一个目录，两边都不会散。
const FONT_DIR = process.env.FONT_DIR || path.resolve(path.dirname(DB_PATH), 'font-files');

if (!SYNC_TOKEN) {
  console.error('\x1b[31m[ERROR]\x1b[0m SYNC_TOKEN environment variable is missing.');
  console.error('Please set it via .env file or environment variable.');
  process.exit(1);
}

if (SYNC_TOKEN.length < 8) {
  console.error('\x1b[31m[ERROR]\x1b[0m SYNC_TOKEN is too weak. Must be at least 8 characters long.');
  process.exit(1);
}

/*
 * 主进程只在要开多进程时才存在：它只管拉起和看护 worker，自己不听端口、不碰数据库。
 *
 * 端口由**每个 worker 自己 listen**，这是 `cluster` 在三个平台上都成立的形态：
 * Linux/macOS 上 cluster 用 round-robin 把新连接轮流交给 worker，Windows 上各自
 * 绑同一个端口（`SCHED_NONE`）。实测 Windows：worker 用 `listen({ reusePort: true })`
 * 会报 `ENOTSUP`，而直接 `listen(PORT)` 正常、两个 worker 各接一半 —— 所以没有平台分支。
 *
 * 反过来「主进程先 listen、worker 靠句柄共享」在 Windows 上不成立：worker 绑不上
 * 已经被占用的端口（`EADDRINUSE`），请求会全落在主进程身上。
 */
if (CLUSTER_WORKERS > 1 && cluster.isPrimary) {
  let shuttingDown = false;
  /* worker 崩了要补一个，否则并发能力会一路降到单进程。 */
  const respawn = (worker: cluster.Worker, code: number | null, signal: string | null) => {
    if (shuttingDown) return;
    console.error(`\x1b[33m[cluster]\x1b[0m worker ${worker.id} 退出（code=${code}, signal=${signal}），正在补一个`);
    cluster.fork();
  };
  cluster.on('exit', respawn);
  const shutdown = () => {
    shuttingDown = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  for (let index = 0; index < CLUSTER_WORKERS; index += 1) cluster.fork();
} else {

const db = new D1Emulator(DB_PATH);
/* 落到文件；老数据还在数据库里，读的时候会自己回退（见 fontBlobs.node.ts）。 */
const fontBlobs = createNodeFontBlobStore(FONT_DIR, createD1FontBlobStore(db));

/*
 * 命中流水（ai_cache_hits）只留七天，但清理原来只挂在「前台看统计图」那条路上 ——
 * 没人看图，流水就一直长。这里每小时清一次，顺手做一次 `PRAGMA optimize`
 * （更新查询计划用的统计信息）。Workers 部署没有定时器，继续靠统计图那条路兜底。
 *
 * 多进程时只让 0 号 worker 干：几份清理同时跑，除了多抢一次写锁没有别的用处。
 */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
let maintenanceRunning = false;
const runsMaintenance = !cluster.isWorker || cluster.worker?.id === 1;
if (runsMaintenance) setInterval(() => {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  Promise.all([
    pruneHitLog(db),
    Promise.resolve(db.optimize()),
  ])
    .catch(() => undefined)
    .finally(() => {
      maintenanceRunning = false;
    });
}, MAINTENANCE_INTERVAL_MS).unref();

const logo = `
\x1b[35m  _____    _ _          \x1b[36m ____                  \x1b[0m
\x1b[35m |  ___|__| (_) __ _    \x1b[36m/ ___| _   _ _ __   ___ \x1b[0m
\x1b[35m | |_ / _ \\ | |/ _\` |   \x1b[36m\\___ \\| | | | '_ \\ / __|\x1b[0m
\x1b[35m |  _| (_) | | | (_| |  \x1b[36m ___) | |_| | | | | (__ \x1b[0m
\x1b[35m |_|  \\___/|_|_|\\__,_|  \x1b[36m|____/ \\__, |_| |_|\\___|\x1b[0m
\x1b[36m                               |___/            \x1b[0m
`;

let version = 'unknown';
try {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch (e) {
  // Ignore
}

/* worker 的启动横幅只留一行，不然 N 份 logo 会把日志刷满。 */
const workerTag = cluster.isWorker ? `\x1b[36m[worker ${cluster.worker?.id}]\x1b[0m ` : '';
if (cluster.isWorker) {
  console.log(`${workerTag}已启动：端口 \x1b[33m${PORT}\x1b[0m，数据库 \x1b[33m${DB_PATH}\x1b[0m`);
} else {
  console.log(logo);
  console.log(`\x1b[32m[Folia Sync Server]\x1b[0m Starting Node.js standalone server (v${version})...`);
  console.log(`- Port: \x1b[33m${PORT}\x1b[0m`);
  console.log(`- Database: \x1b[33m${DB_PATH}\x1b[0m`);
  console.log(`- Font files: \x1b[33m${FONT_DIR}\x1b[0m`);
  console.log(`- Processes: \x1b[33m${CLUSTER_WORKERS > 1 ? `${CLUSTER_WORKERS} 个进程` : '1 个进程（单进程）'}\x1b[0m`);
  if (DASHBOARD_TOKEN) {
    console.log(`- Dashboard: \x1b[36mhttp://localhost:${PORT}/?token=${DASHBOARD_TOKEN}\x1b[0m`);
  } else {
    console.log(`- Dashboard: Disabled (DASHBOARD_TOKEN not set)`);
  }
  const adminCredentials = readAdminCredentials({ ADMIN_USERNAME, ADMIN_PASSWORD });
  if (adminCredentials) {
    console.log(`- Admin panel: \x1b[36mhttp://localhost:${PORT}/admin\x1b[0m (${adminCredentials.username})`);
  } else {
    console.warn('[admin] Panel disabled: set ADMIN_USERNAME and ADMIN_PASSWORD (at least 16 non-padding characters).');
  }
}

serve({
  fetch: (req) => app.fetch(req, {
    FOLIA_SYNC_DB: db,
    SYNC_TOKEN,
    DASHBOARD_TOKEN,
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    ADMIN_PUBLIC_ORIGIN,
    FONT_BLOBS: fontBlobs,
    readDatabaseBytes: () => {
      try {
        return fs.statSync(DB_PATH).size;
      } catch {
        return null;
      }
    },
  }),
  port: PORT,
}).on('error', (error) => {
  /* 端口被占、权限不够这类问题，与其静默退化成「服务在跑但请求全挂」，不如直接退出。 */
  console.error(`${workerTag}\x1b[31m[ERROR]\x1b[0m 监听端口 ${PORT} 失败：`, error);
  process.exit(1);
});
}
