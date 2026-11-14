// client.mjs — 模组市场的渲染端。
//
// 主页导航末尾多一个整页「模组市场」：直接读官方市场的 catalog.json，把模组按卡片列出来，
// 点「安装」就地完成「下载 → 校验 → 解压 → 装进 mods 目录 → 叫出启用确认」，不用再去浏览器。
// 已装模组会拿 catalog 里的版本比一次，有新版就在卡片上标出来，支持单个更新与全部更新。
//
// 边界：
//   · 下载与解压都不在这里。这里只发 rpc 让 Node 端把包下到缓存并核对 SHA-256，
//     再把落盘路径交给宿主自己的 installModFromZip —— 它才是往 mods 目录写东西的那一个。
//   · 启用同样不绕过：装完调宿主的 setModEnabled，弹的是宿主原生的确认窗口，
//     签名、权限、内容摘要都由宿主自己核对，我们连读都不读。

const CATALOG_ORIGIN = 'https://folium-compound.cielaniska.top';

const PERMISSION_TEXT = {
    'filesystem.data': { zh: '读写它自己的数据文件', en: 'Read and write its own data file' },
    'playback.read': { zh: '读取当前播放状态', en: 'Read the playback state' },
    'playback.control': { zh: '控制播放：播放、暂停、跳转、切歌', en: 'Control playback: play, pause, seek, skip' },
    'playback.queue': { zh: '替换播放队列', en: 'Replace the play queue' },
    'equalizer.control': { zh: '调整均衡器', en: 'Control the equalizer' },
    'render.export': { zh: '导出歌词视频', en: 'Export lyric videos' },
    'net.fetch': { zh: '访问网络', en: 'Access the network' },
    'net.embed': { zh: '嵌入外部网页', en: 'Embed external web pages' },
    stageLayers: { zh: '在播放页上绘制图层', en: 'Draw layers on the player page' },
    'platform.netease.read': { zh: '读取网易云数据', en: 'Read NetEase data' },
    'platform.netease.write': { zh: '修改网易云数据', en: 'Write NetEase data' },
};

const EXPERIMENTAL_TEXT = {
    'platform.raw': { zh: '网易云实验接口', en: 'NetEase experimental API' },
    'omni.hooks': { zh: '音源替换钩子', en: 'Audio source hooks' },
    'omni.providers': { zh: '自定义音源', en: 'Custom providers' },
    'ponder.targets': { zh: '思索教程锚点', en: 'Ponder tutorial anchors' },
    'player.layout': { zh: '播放页布局', en: 'Player layout' },
    'remote.actions': { zh: '遥控窗口动作', en: 'Remote window actions' },
};

// 宿主 installModFromZip / 下载链路的错误码 → 一句人话。
const ERROR_TEXT = {
    'install-not-zip': '这个地址给的不是 zip 包。',
    'install-too-large': '包太大了，超过宿主的 64MB 上限。',
    'install-too-many-files': '包里的文件太多，宿主拒绝安装。',
    'install-corrupt-zip': 'zip 包损坏或读不出来。',
    'install-empty-zip': 'zip 是空的。',
    'install-no-manifest': '包里找不到 mod.json，可能不是模组包。',
    'install-invalid-manifest': 'mod.json 不合规，宿主拒绝安装。',
    'install-main-missing': '包里缺 main 入口文件。',
    'install-client-missing': '包里缺 client 入口文件。',
    'install-unsafe-path': '包里有越界路径，已拒绝安装。',
    'install-main-failed': '安装过程出错了。',
    'mod-system-disabled': '模组系统没有开启，先到设置里打开。',
    'download-checksum-mismatch': '下载到的包与官方公布的 SHA-256 不符，已丢弃。',
    'download-timeout': '下载超时，检查一下网络或代理。',
    'download-empty': '下载到的是空文件，稍后重试。',
    'download-http-404': '官方站上没有这个文件（可能刚更新过，刷新试试）。',
    'market-no-checksum': '这个模组在 catalog 里没有哈希，为安全起见不装。',
    'market-bad-url': '下载地址不在官方站上，已拒绝。',
    'catalog-timeout': '读取模组市场超时。',
    'catalog-not-json': '模组市场返回的内容看不懂。',
    'catalog-unexpected-format': '模组市场的格式变了，本模组可能该更新了。',
    'no-install-bridge': '当前 Folia 版本没有开放安装接口，请把 Folia 升到 0.7.22 以上。',
    'no-bridge': '找不到 Folia 的模组接口，模组系统可能没有开启。',
    'enable-declined': '已安装，但没有启用。',
};

const CSS = `
.mm-root{
  --mm-bg:transparent;
  --mm-ink:#e9e9ef;
  --mm-muted:#8b8b97;
  --mm-line:color-mix(in srgb, var(--mm-ink) 12%, transparent);
  --mm-surface:color-mix(in srgb, var(--mm-ink) 5%, transparent);
  --mm-surface-2:color-mix(in srgb, var(--mm-ink) 9%, transparent);
  --mm-accent:#b6a1f0;
  height:100%;min-height:0;display:flex;flex-direction:column;color:var(--mm-ink);
  font-family:var(--mm-font,inherit);font-size:13px;line-height:1.5;
}
.mm-root *{box-sizing:border-box}
.mm-root button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}
.mm-root button:disabled{cursor:default;opacity:.45}
.mm-root input{font:inherit}
.mm-root ::-webkit-scrollbar{width:8px;height:8px}
.mm-root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--mm-ink) 18%,transparent);border-radius:4px}

.mm-head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px;padding:2px 0 12px;flex:none}
.mm-title{font-size:19px;font-weight:700;letter-spacing:.01em;display:flex;align-items:center;gap:8px}
.mm-title small{font-size:11.5px;font-weight:400;color:var(--mm-muted);letter-spacing:0}
.mm-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.mm-meta{flex:1 1 100%;display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--mm-muted);min-height:0}
.mm-meta a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--mm-line);cursor:pointer}
.mm-meta a:hover{color:var(--mm-ink)}

.mm-btn{display:inline-flex;align-items:center;gap:5px;border-radius:9px;padding:6px 12px;font-size:12px;
  border:1px solid var(--mm-line);background:var(--mm-surface);transition:background .14s,border-color .14s,transform .14s;white-space:nowrap}
.mm-btn:hover:not(:disabled){background:var(--mm-surface-2);border-color:color-mix(in srgb,var(--mm-ink) 24%,transparent)}
.mm-btn.is-primary{background:var(--mm-accent);border-color:transparent;color:#12101a;font-weight:600}
.mm-btn.is-primary:hover:not(:disabled){filter:brightness(1.06)}
.mm-btn.is-ghost{background:transparent}
.mm-btn.is-small{padding:4px 9px;font-size:11.5px;border-radius:7px}
.mm-btn.is-icon{padding:6px;border-radius:9px}

.mm-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0 0 12px;flex:none}
.mm-search{position:relative;flex:1 1 200px;min-width:150px}
.mm-search input{width:100%;padding:7px 10px 7px 30px;border-radius:9px;border:1px solid var(--mm-line);
  background:var(--mm-surface);color:var(--mm-ink);outline:none;font-size:12.5px}
.mm-search input:focus{border-color:color-mix(in srgb,var(--mm-accent) 60%,var(--mm-line))}
.mm-search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);opacity:.45;pointer-events:none}
.mm-chips{display:flex;flex-wrap:wrap;gap:4px}
.mm-chip{border-radius:999px;padding:5px 11px;font-size:11.5px;border:1px solid transparent;
  background:var(--mm-surface);color:var(--mm-muted)}
.mm-chip:hover{color:var(--mm-ink)}
.mm-chip.is-on{background:color-mix(in srgb,var(--mm-accent) 22%,transparent);color:var(--mm-ink);
  border-color:color-mix(in srgb,var(--mm-accent) 45%,transparent);font-weight:600}

.mm-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;padding:9px 12px;border-radius:10px;
  background:color-mix(in srgb,var(--mm-accent) 14%,transparent);border:1px solid color-mix(in srgb,var(--mm-accent) 32%,transparent);font-size:12px}
.mm-banner.is-warn{background:color-mix(in srgb,#e0a13a 14%,transparent);border-color:color-mix(in srgb,#e0a13a 36%,transparent)}
.mm-banner .mm-btn{margin-left:auto}

.mm-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 2px 24px}
.mm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:12px}

.mm-card{display:flex;flex-direction:column;border-radius:13px;overflow:hidden;border:1px solid var(--mm-line);
  background:var(--mm-surface);transition:border-color .16s,transform .16s,background .16s}
.mm-card:hover{border-color:color-mix(in srgb,var(--mm-ink) 26%,transparent);transform:translateY(-1px);
  background:color-mix(in srgb,var(--mm-ink) 7%,transparent)}
.mm-thumb{position:relative;aspect-ratio:16/9;background:color-mix(in srgb,var(--mm-ink) 10%,transparent);overflow:hidden}
.mm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.mm-thumb .mm-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;
  font-size:26px;font-weight:700;opacity:.28;letter-spacing:.04em}
.mm-card-badges{position:absolute;left:8px;top:8px;display:flex;gap:4px;flex-wrap:wrap;max-width:calc(100% - 16px)}
.mm-tag{font-size:10px;line-height:1.6;padding:0 7px;border-radius:999px;background:rgba(10,10,14,.62);color:#f2f2f7;
  backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.14);white-space:nowrap}
.mm-tag.is-official{background:rgba(88,64,168,.72);border-color:rgba(180,160,255,.5)}
.mm-tag.is-beta{background:rgba(150,102,20,.72);border-color:rgba(240,190,110,.5)}
.mm-tag.is-update{background:rgba(20,120,90,.78);border-color:rgba(120,230,190,.5)}
.mm-tag.is-installed{background:rgba(20,20,26,.72)}

.mm-card-main{padding:10px 11px 0;display:flex;flex-direction:column;gap:4px;min-width:0}
.mm-card-name{font-size:13.5px;font-weight:650;line-height:1.35;display:flex;align-items:baseline;gap:6px}
.mm-card-name span.mm-ver{font-size:10.5px;font-weight:400;color:var(--mm-muted);flex:none}
.mm-card-by{font-size:11px;color:var(--mm-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm-card-desc{font-size:11.5px;line-height:1.62;color:color-mix(in srgb,var(--mm-ink) 72%,transparent);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word;margin:2px 0 0}
.mm-card-foot{display:flex;align-items:center;gap:6px;padding:9px 11px 11px;margin-top:auto}
.mm-card-foot .mm-btn:first-child{margin-left:auto}
.mm-perm-dot{font-size:10.5px;color:var(--mm-muted);display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}

.mm-progress{height:2px;border-radius:2px;background:color-mix(in srgb,var(--mm-ink) 12%,transparent);overflow:hidden;margin-top:8px}
.mm-progress i{display:block;height:100%;width:38%;border-radius:2px;background:var(--mm-accent);animation:mmSlide 1.1s ease-in-out infinite}
@keyframes mmSlide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.mm-job{font-size:11px;color:var(--mm-muted);padding:0 11px 10px;display:flex;align-items:center;gap:6px}
.mm-job.is-err{margin:6px 10px 2px;padding:6px 9px;border-radius:8px;line-height:1.55;white-space:normal;
  word-break:break-word;background:color-mix(in srgb,#e2725b 14%,transparent);
  border:1px solid color-mix(in srgb,#e2725b 34%,transparent);color:#e88d7d}

.mm-state{padding:34px 6px;text-align:center;color:var(--mm-muted);font-size:12.5px;line-height:1.9}
.mm-state b{color:var(--mm-ink);font-weight:600}
.mm-empty{padding:44px 10px;text-align:center;color:var(--mm-muted);font-size:12.5px}

.mm-detail{display:flex;flex-direction:column;gap:14px;max-width:820px}
.mm-detail-top{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.mm-detail-cover{flex:0 0 240px;max-width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;
  background:color-mix(in srgb,var(--mm-ink) 10%,transparent);border:1px solid var(--mm-line)}
.mm-detail-cover img{width:100%;height:100%;object-fit:cover;display:block}
.mm-detail-head{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:6px}
.mm-detail-name{font-size:20px;font-weight:700;line-height:1.3;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.mm-detail-name .mm-ver{font-size:12px;font-weight:400;color:var(--mm-muted)}
.mm-detail-sub{font-size:12px;color:var(--mm-muted)}
.mm-detail-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.mm-section{border-top:1px solid var(--mm-line);padding-top:12px}
.mm-section h4{margin:0 0 7px;font-size:11.5px;font-weight:600;color:var(--mm-muted);letter-spacing:.03em}
.mm-desc{font-size:12.5px;line-height:1.78;white-space:pre-wrap;word-break:break-word;color:color-mix(in srgb,var(--mm-ink) 88%,transparent)}
.mm-kv{display:grid;grid-template-columns:88px 1fr;gap:4px 10px;font-size:12px;line-height:1.7}
.mm-kv dt{color:var(--mm-muted)}
.mm-kv dd{margin:0;word-break:break-word}
.mm-kv code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.82}
.mm-list{display:flex;flex-direction:column;gap:5px;font-size:12px}
.mm-list div{display:flex;gap:7px;align-items:baseline}
.mm-list em{font-style:normal;color:var(--mm-muted);font-size:11px}
.mm-pill{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--mm-surface-2);
  border:1px solid var(--mm-line);color:var(--mm-muted);white-space:nowrap}
.mm-pill.is-official{background:color-mix(in srgb,var(--mm-accent) 26%,transparent);border-color:transparent;color:var(--mm-ink)}
.mm-pill.is-beta{background:color-mix(in srgb,#e0a13a 26%,transparent);border-color:transparent;color:var(--mm-ink)}
.mm-pill.is-update{background:color-mix(in srgb,#3fbf94 26%,transparent);border-color:transparent;color:var(--mm-ink)}
`.trim();

const SVG_SEARCH =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>';
const SVG_REFRESH =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
const SVG_BACK =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';

export default function activate(folium) {
    if (!folium || folium.env?.context !== 'main') return undefined;

    let locale = 'zh-CN';
    const isZh = () => /^zh/i.test(String(locale));
    const t = (zh, en) => (isZh() ? zh : en);

    const log = (message) => {
        try {
            folium.log?.info?.(`[市场] ${message}`);
        } catch (_) {}
    };
    const warn = (message) => {
        try {
            folium.log?.warn?.(`[市场] ${message}`);
        } catch (_) {}
    };
    const toast = (message, type) => {
        try {
            folium.ui?.toast?.(message, type ? { type } : undefined);
        } catch (_) {}
    };

    const esc = (value) =>
        String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[character]);

    const bridge = () => {
        try {
            return window.electron?.mods ?? null;
        } catch (_) {
            return null;
        }
    };

    const rpc = async (name, payload) => {
        try {
            return await folium.rpc.call(name, payload);
        } catch (error) {
            warn(`rpc ${name} 失败：${String(error?.message || error)}`);
            return { ok: false, error: String(error?.message || error) };
        }
    };

    const humanError = (code) => {
        const raw = String(code ?? '');
        const key = raw.split(':')[0];
        if (ERROR_TEXT[key]) return ERROR_TEXT[key];
        if (raw.startsWith('install-invalid-manifest')) return ERROR_TEXT['install-invalid-manifest'];
        if (/^download-http-\d+$/.test(raw)) return t(`下载失败（HTTP ${raw.slice(-3)}）。`, `Download failed (HTTP ${raw.slice(-3)}).`);
        if (/^catalog-http-\d+$/.test(raw)) return t(`读取模组市场失败（HTTP ${raw.slice(-3)}）。`, `Catalog request failed (HTTP ${raw.slice(-3)}).`);
        return raw || t('未知错误', 'Unknown error');
    };

    /* ------------------------------------------------------------- 设置项 */

    const L = (zh, en) => ({ 'zh-CN': zh, en });

    let settingsHandle = null;
    try {
        settingsHandle = folium.registries?.settingsSections?.register?.({
            id: 'prefs',
            label: L('模组市场', 'Mod market'),
            description: L(
                '市场页在首页导航的末尾，也会在命令面板里出现「打开模组市场」。安装走宿主自己的安装器，装完仍要你在宿主的确认窗口里点头才会启用。',
                'The market lives at the end of the home navigation. Installs go through the host installer, and enabling still asks for your confirmation.'
            ),
            settings: [
                {
                    key: 'autoCheck',
                    type: 'boolean',
                    defaultValue: true,
                    label: L('打开市场时自动刷新', 'Refresh when the market opens'),
                    description: L('关闭后只在点刷新时联网，其余时间用本地缓存。', 'When off, only the refresh button goes online.'),
                },
                {
                    key: 'showPreview',
                    type: 'boolean',
                    defaultValue: true,
                    label: L('显示预览图', 'Show preview images'),
                    description: L('预览图来自官方站，关闭后只显示首字母占位。', 'Previews come from the official site; off shows a letter placeholder.'),
                },
                {
                    key: 'betaChannel',
                    type: 'boolean',
                    defaultValue: false,
                    label: L('显示 Beta 模组', 'Show beta mods'),
                    description: L(
                        'Beta 只过了安全审查，功能可能跑不起来，多数人用不上；过滤条里也能临时切换。',
                        'Beta mods passed the security review only and may not work at all. The filter row can toggle them too.'
                    ),
                },
            ],
        });
    } catch (error) {
        warn(`设置区注册失败：${String(error?.message || error)}`);
    }

    const readSettings = () => {
        let raw = null;
        try {
            raw = settingsHandle?.settings?.get?.() ?? null;
        } catch (_) {
            raw = null;
        }
        const value = raw && typeof raw === 'object' ? raw : {};
        return {
            autoCheck: value.autoCheck !== false,
            showPreview: value.showPreview !== false,
            betaChannel: value.betaChannel === true,
        };
    };

    /* --------------------------------------------------------------- 状态 */

    const state = {
        catalog: null, // { mods, fetchedAt, source, stale, error }
        installed: new Map(), // id -> { version, name, directory }
        host: new Map(), // id -> { enabled, status, signature }
        loading: false,
        error: null,
        query: '',
        filter: 'all', // all | official | community | beta | installed
        view: 'list', // list | detail
        detailId: null,
        jobs: new Map(), // id -> { phase, error }
        mounted: false,
    };

    const parseVersion = (version) => {
        const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
        return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
    };

    const compareVersion = (left, right) => {
        const a = parseVersion(left);
        const b = parseVersion(right);
        if (!a || !b) return String(left ?? '').localeCompare(String(right ?? ''));
        if (a.major !== b.major) return a.major - b.major;
        if (a.minor !== b.minor) return a.minor - b.minor;
        return a.patch - b.patch;
    };

    const formatSize = (bytes) => {
        const value = Number(bytes) || 0;
        if (value <= 0) return '';
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
    };

    const formatTime = (stamp) => {
        if (!stamp) return '';
        const date = new Date(stamp);
        if (Number.isNaN(date.getTime())) return '';
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };

    const relativeTime = (stamp) => {
        const time = Number(stamp) || 0;
        if (!time) return '';
        const diff = Math.max(0, Date.now() - time);
        const minute = 60 * 1000;
        if (diff < minute) return t('刚刚', 'just now');
        if (diff < 60 * minute) return t(`${Math.round(diff / minute)} 分钟前`, `${Math.round(diff / minute)} min ago`);
        if (diff < 24 * 60 * minute) return t(`${Math.round(diff / (60 * minute))} 小时前`, `${Math.round(diff / (60 * minute))} h ago`);
        return t(`${Math.round(diff / (24 * 60 * minute))} 天前`, `${Math.round(diff / (24 * 60 * minute))} d ago`);
    };

    const jobOf = (id) => state.jobs.get(id) ?? null;

    const setJob = (id, job) => {
        if (job) state.jobs.set(id, job);
        else state.jobs.delete(id);
        paint();
    };

    /* ------------------------------------------------------------ 数据合并 */

    const rows = () => {
        const catalogMods = state.catalog?.mods ?? [];
        const list = catalogMods.map((mod) => {
            const installed = state.installed.get(mod.id) ?? null;
            const host = state.host.get(mod.id) ?? null;
            const installedVersion = installed?.version ?? host?.version ?? null;
            const hasUpdate = Boolean(installedVersion) && compareVersion(mod.version, installedVersion) > 0;
            return {
                ...mod,
                installedVersion,
                installed: Boolean(installedVersion),
                enabled: host?.enabled === true,
                status: host?.status ?? null,
                signature: host?.signature ?? null,
                hasUpdate,
            };
        });

        // 装在本地但市场上没有的模组：也列出来，至少能点进目录看看。
        state.installed.forEach((installed, id) => {
            if (catalogMods.some((mod) => mod.id === id)) return;
            const host = state.host.get(id) ?? null;
            list.push({
                id,
                name: installed.name || id,
                version: installed.version || '—',
                author: installed.author || '',
                description: t('这个模组不在官方市场里（本地安装或第三方来源），市场无法为它检查更新。', 'This mod is not in the official market, so updates cannot be checked.'),
                origin: 'local',
                channel: 'release',
                permissions: [],
                experimental: [],
                depends: [],
                owners: [],
                source: '',
                folia: null,
                preview: null,
                page: null,
                download: null,
                installedVersion: installed.version || null,
                installed: true,
                enabled: host?.enabled === true,
                status: host?.status ?? null,
                signature: host?.signature ?? null,
                hasUpdate: false,
                localOnly: true,
            });
        });

        return list.sort((left, right) => left.name.localeCompare(right.name, isZh() ? 'zh-Hans-CN' : 'en'));
    };

    const visibleRows = () => {
        const settings = readSettings();
        const query = state.query.trim().toLowerCase();
        return rows().filter((row) => {
            if (state.filter === 'installed' && !row.installed) return false;
            if (state.filter === 'official' && row.origin !== 'official') return false;
            if (state.filter === 'community' && row.origin !== 'community') return false;
            if (state.filter === 'beta' && row.channel !== 'beta') return false;
            if (!settings.betaChannel && state.filter !== 'beta' && state.filter !== 'installed' && row.channel === 'beta') {
                return false;
            }
            if (!query) return true;
            return [row.name, row.id, row.author, row.description, row.owners.join(' ')]
                .join(' ')
                .toLowerCase()
                .includes(query);
        });
    };

    /* --------------------------------------------------------------- 刷新 */

    const refresh = async ({ force = false, quiet = false } = {}) => {
        if (state.loading) return;
        state.loading = true;
        state.error = null;
        if (!quiet) paint();

        try {
            const [catalog, installed] = await Promise.all([
                rpc('market.catalog', { force }),
                rpc('market.installed'),
            ]);

            if (catalog?.ok) {
                state.catalog = catalog;
                state.error = catalog.stale && catalog.error ? humanError(catalog.error) : null;
            } else if (!state.catalog) {
                state.error = humanError(catalog?.error);
            }

            if (installed?.ok) {
                const map = new Map();
                (installed.mods ?? []).forEach((mod) => {
                    map.set(mod.id, { version: mod.version, name: mod.name, author: mod.author, directory: mod.directory });
                });
                state.installed = map;
            }

            const api = bridge();
            if (api?.listMods) {
                try {
                    const answer = await api.listMods();
                    const map = new Map();
                    (answer?.mods ?? []).forEach((mod) => {
                        map.set(mod.id, {
                            enabled: mod.enabled === true,
                            status: mod.status ?? null,
                            version: mod.version ?? null,
                            signature: mod.signature ?? null,
                        });
                    });
                    state.host = map;
                } catch (error) {
                    warn(`读取已装模组状态失败：${String(error?.message || error)}`);
                }
            }

            const count = state.catalog?.mods?.length ?? 0;
            log(`市场 ${count} 个模组，已装 ${state.installed.size} 个，来源 ${state.catalog?.source ?? 'none'}`);
        } finally {
            state.loading = false;
            paint();
        }
    };

    /* --------------------------------------------------------------- 安装 */

    const enableMod = async (id) => {
        const api = bridge();
        if (!api?.setModEnabled) {
            return { ok: false, error: 'no-bridge' };
        }
        const answer = await api.setModEnabled(id, true);
        return { ok: answer?.ok === true, error: answer?.error ?? null };
    };

    const install = async (row) => {
        if (jobOf(row.id)) return;
        if (!row.download) {
            toast(t('这个模组没有可下载的包。', 'This mod has no downloadable package.'), 'error');
            return;
        }

        setJob(row.id, { phase: 'download' });
        try {
            const download = await rpc('market.download', {
                id: row.id,
                url: row.download.url,
                sha256: row.download.sha256,
                version: row.version,
            });
            if (!download?.ok) {
                const message = humanError(download?.error);
                setJob(row.id, { phase: 'error', error: message });
                toast(t(`「${row.name}」下载失败：${message}`, `${row.name}: ${message}`), 'error');
                return;
            }

            setJob(row.id, { phase: 'install' });
            const api = bridge();
            if (!api?.installModFromZip) {
                setJob(row.id, { phase: 'error', error: humanError('no-install-bridge') });
                return;
            }
            const answer = await api.installModFromZip(download.path);
            if (!answer?.ok) {
                const message = humanError(answer?.error);
                setJob(row.id, { phase: 'error', error: message });
                toast(t(`「${row.name}」安装失败：${message}`, `${row.name}: ${message}`), 'error');
                return;
            }

            // 装好了：宿主的安装器已经做过一次 loadAll，包也不再需要。
            void rpc('market.dropPackage', { path: download.path });

            setJob(row.id, { phase: 'enable' });
            const enabled = await enableMod(row.id);
            setJob(row.id, null);

            if (enabled.ok) {
                toast(t(`「${row.name}」已安装并启用`, `${row.name} installed and enabled`), 'info');
            } else if (String(enabled.error ?? '').includes('declined')) {
                toast(t(`「${row.name}」已安装，你取消了启用`, `${row.name} installed; enabling was cancelled`), 'info');
            } else {
                toast(t(`「${row.name}」已安装，启用时出错了：${humanError(enabled.error)}`, `${row.name} installed but enabling failed`), 'error');
            }
        } catch (error) {
            const message = String(error?.message || error);
            setJob(row.id, { phase: 'error', error: message });
            toast(`${row.name}: ${message}`, 'error');
        } finally {
            await refresh({ force: false, quiet: true });
        }
    };

    const enableOnly = async (row) => {
        if (jobOf(row.id)) return;
        setJob(row.id, { phase: 'enable' });
        const answer = await enableMod(row.id);
        setJob(row.id, null);
        if (!answer.ok) {
            const message = humanError(answer.error);
            if (!String(answer.error ?? '').includes('declined')) {
                toast(`${row.name}: ${message}`, 'error');
            }
        }
        await refresh({ force: false, quiet: true });
    };

    const updateAll = async () => {
        const pending = rows().filter((row) => row.hasUpdate && !jobOf(row.id));
        if (pending.length === 0) return;
        toast(t(`开始更新 ${pending.length} 个模组`, `Updating ${pending.length} mods`), 'info');
        // 一次一个：宿主的 install 会在结尾重载所有模组，并发会把彼此的安装搅在一起。
        for (const row of pending) {
            // eslint-disable-next-line no-await-in-loop
            await install(row);
        }
    };

    const openInBrowser = (url) => {
        if (!url) return;
        const api = window.electron;
        if (api?.openExternalUrl) {
            void api.openExternalUrl(url);
            return;
        }
        try {
            window.open(url, '_blank', 'noopener');
        } catch (error) {
            warn(`打开外部链接失败：${String(error?.message || error)}`);
        }
    };

    /* --------------------------------------------------------------- 绘制 */

    let root = null;
    let body = null;
    let headMeta = null;
    let toolbar = null;

    const permissionText = (id) => {
        const entry = PERMISSION_TEXT[id];
        if (!entry) return id;
        return isZh() ? entry.zh : entry.en;
    };

    const experimentalText = (id) => {
        const entry = EXPERIMENTAL_TEXT[id];
        if (!entry) return id;
        return isZh() ? entry.zh : entry.en;
    };

    const badgesOf = (row) => {
        const badges = [];
        if (row.channel === 'beta') {
            badges.push(`<span class="mm-tag is-beta">Beta</span>`);
        } else if (row.origin === 'official') {
            badges.push(`<span class="mm-tag is-official">${esc(t('官方', 'Official'))}</span>`);
        } else if (row.origin === 'community') {
            badges.push(`<span class="mm-tag">${esc(t('社区', 'Community'))}</span>`);
        } else {
            badges.push(`<span class="mm-tag">${esc(t('本地', 'Local'))}</span>`);
        }
        if (row.hasUpdate) {
            badges.push(`<span class="mm-tag is-update">${esc(t('可更新', 'Update'))}</span>`);
        } else if (row.installed) {
            badges.push(`<span class="mm-tag is-installed">${esc(t('已安装', 'Installed'))}</span>`);
        }
        return badges.join('');
    };

    const thumbHtml = (row, settings) => {
        if (settings.showPreview && row.preview?.url) {
            return `<div class="mm-thumb"><img src="${esc(row.preview.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb><div class="mm-card-badges">${badgesOf(row)}</div></div>`;
        }
        return `<div class="mm-thumb"><div class="mm-ph">${esc(String(row.name || row.id).slice(0, 2))}</div><div class="mm-card-badges">${badgesOf(row)}</div></div>`;
    };

    const cardAction = (row) => {
        const job = jobOf(row.id);
        if (job && job.phase !== 'error') {
            const label =
                job.phase === 'download'
                    ? t('下载中…', 'Downloading…')
                    : job.phase === 'install'
                        ? t('安装中…', 'Installing…')
                        : t('等待确认…', 'Waiting…');
            return `<button class="mm-btn is-small" disabled>${esc(label)}</button>`;
        }
        // 出错后把按钮还给用户，改完网络 / 权限能直接重来
        const retry = job?.phase === 'error';
        if (retry) {
            const act = row.hasUpdate || !row.installed ? 'install' : 'enable';
            return `<button class="mm-btn is-small is-primary" data-act="${act}" data-id="${esc(row.id)}">${esc(t('重试', 'Retry'))}</button>`;
        }
        if (row.localOnly) {
            if (!row.installed) {
                return `<button class="mm-btn is-small" disabled>${esc(t('市场外', 'Not in market'))}</button>`;
            }
            return row.enabled
                ? `<button class="mm-btn is-small" disabled>${esc(t('已启用', 'Enabled'))}</button>`
                : `<button class="mm-btn is-small is-primary" data-act="enable" data-id="${esc(row.id)}">${esc(t('启用', 'Enable'))}</button>`;
        }
        if (row.hasUpdate) {
            return `<button class="mm-btn is-small is-primary" data-act="install" data-id="${esc(row.id)}">${esc(t(`更新到 ${row.version}`, `Update to ${row.version}`))}</button>`;
        }
        if (row.installed) {
            if (row.enabled) {
                return `<button class="mm-btn is-small" disabled>${esc(t('已启用', 'Enabled'))}</button>`;
            }
            return `<button class="mm-btn is-small is-primary" data-act="enable" data-id="${esc(row.id)}">${esc(t('启用', 'Enable'))}</button>`;
        }
        return `<button class="mm-btn is-small is-primary" data-act="install" data-id="${esc(row.id)}">${esc(t('安装', 'Install'))}</button>`;
    };

    const cardHtml = (row, settings) => {
        const job = jobOf(row.id);
        const permCount = row.permissions.length;
        const permHint = permCount === 0
            ? t('无需权限', 'No permissions')
            : t(`${permCount} 项权限`, `${permCount} permissions`);
        const jobRow = job
            ? job.phase === 'error'
                ? `<div class="mm-job is-err">${esc(job.error || t('出错了', 'Failed'))}</div>`
                : `<div class="mm-progress"><i></i></div><div class="mm-job">${esc(
                    job.phase === 'download' ? t('正在下载并核对哈希…', 'Downloading and verifying…')
                        : job.phase === 'install' ? t('交给宿主安装…', 'Installing…')
                            : t('等待宿主确认窗口…', 'Waiting for the host dialog…')
                )}</div>`
            : '';
        return (
            `<article class="mm-card" data-card="${esc(row.id)}">` +
            thumbHtml(row, settings) +
            `<div class="mm-card-main">` +
            `<div class="mm-card-name">${esc(row.name)}<span class="mm-ver">v${esc(row.version)}</span></div>` +
            `<div class="mm-card-by">${esc(row.author || t('未署名', 'unattributed'))}${
                row.installedVersion && row.installedVersion !== row.version
                    ? ` · ${esc(t(`已装 ${row.installedVersion}`, `installed ${row.installedVersion}`))}`
                    : ''
            }</div>` +
            `<p class="mm-card-desc">${esc(row.description)}</p>` +
            `</div>` +
            jobRow +
            `<div class="mm-card-foot">` +
            `<span class="mm-perm-dot">${esc(permHint)}${row.download && row.download.size ? ` · ${esc(formatSize(row.download.size))}` : ''}</span>` +
            `<button class="mm-btn is-small is-ghost" data-act="detail" data-id="${esc(row.id)}">${esc(t('详情', 'Details'))}</button>` +
            cardAction(row) +
            `</div></article>`
        );
    };

    const listHtml = () => {
        const settings = readSettings();
        const list = visibleRows();

        if (state.loading && !state.catalog && list.length === 0) {
            return `<div class="mm-state">${esc(t('正在读取官方模组市场…', 'Loading the official market…'))}</div>`;
        }
        if (!state.catalog && state.error) {
            return (
                `<div class="mm-state">${esc(state.error)}<br>` +
                `<button class="mm-btn is-small" data-act="refresh" style="margin-top:12px">${esc(t('重试', 'Retry'))}</button></div>`
            );
        }
        if (list.length === 0) {
            return `<div class="mm-empty">${esc(
                state.query
                    ? t('没有匹配的模组，换个关键词试试。', 'No mods match that search.')
                    : t('这个过滤条件下没有模组。', 'No mods under this filter.')
            )}</div>`;
        }

        const updates = rows().filter((row) => row.hasUpdate);
        const banner = updates.length > 0
            ? `<div class="mm-banner">${esc(t(`${updates.length} 个模组有新版本`, `${updates.length} updates available`))}` +
              `<button class="mm-btn is-small" data-act="update-all">${esc(t('全部更新', 'Update all'))}</button></div>`
            : '';

        return banner + `<div class="mm-grid">${list.map((row) => cardHtml(row, settings)).join('')}</div>`;
    };

    const detailHtml = () => {
        const row = rows().find((entry) => entry.id === state.detailId);
        if (!row) {
            return `<div class="mm-empty">${esc(t('这个模组不见了，返回列表刷新一下。', 'That mod vanished; go back and refresh.'))}</div>`;
        }
        const settings = readSettings();
        const job = jobOf(row.id);

        const perms = row.permissions.length === 0
            ? `<div class="mm-list"><div><em>${esc(t('无需任何权限', 'No permissions'))}</em></div></div>`
            : `<div class="mm-list">${row.permissions
                .map((id) => `<div><span class="mm-pill">${esc(id)}</span><span>${esc(permissionText(id))}</span></div>`)
                .join('')}</div>`;

        const experiments = row.experimental.length > 0
            ? `<div class="mm-section"><h4>${esc(t('实验性接口', 'Experimental'))}</h4><div class="mm-list">${row.experimental
                .map((id) => `<div><span class="mm-pill">${esc(id)}</span><span>${esc(experimentalText(id))}</span></div>`)
                .join('')}</div></div>`
            : '';

        const signature = row.signature?.keyLabel
            ? `${esc(row.signature.keyLabel)}${row.signature.status ? ` · ${esc(row.signature.status)}` : ''}`
            : row.keyLabel
                ? esc(row.keyLabel)
                : esc(t('未签名（本地模组不受官方签名约束）', 'Unsigned'));

        const action = job && job.phase !== 'error'
            ? `<button class="mm-btn is-primary" disabled>${esc(
                job.phase === 'download' ? t('下载中…', 'Downloading…')
                    : job.phase === 'install' ? t('安装中…', 'Installing…')
                        : t('等待确认…', 'Waiting…')
            )}</button>`
            : job?.phase === 'error'
                ? `<button class="mm-btn is-primary" data-act="${row.hasUpdate || !row.installed ? 'install' : 'enable'}" data-id="${esc(row.id)}">${esc(t('重试', 'Retry'))}</button>`
            : row.localOnly
                ? `<button class="mm-btn" data-act="open-dir">${esc(t('打开模组目录', 'Open mods folder'))}</button>`
                : row.hasUpdate
                    ? `<button class="mm-btn is-primary" data-act="install" data-id="${esc(row.id)}">${esc(t(`更新到 ${row.version}`, `Update to ${row.version}`))}</button>`
                    : row.installed
                        ? row.enabled
                            ? `<button class="mm-btn" disabled>${esc(t('已启用', 'Enabled'))}</button>`
                            : `<button class="mm-btn is-primary" data-act="enable" data-id="${esc(row.id)}">${esc(t('启用', 'Enable'))}</button>`
                        : `<button class="mm-btn is-primary" data-act="install" data-id="${esc(row.id)}">${esc(t('安装', 'Install'))}</button>`;

        const errorRow = job?.phase === 'error'
            ? `<div class="mm-banner is-warn">${esc(job.error || '')}</div>`
            : '';

        const cover = settings.showPreview && row.preview?.url
            ? `<div class="mm-detail-cover"><img src="${esc(row.preview.url)}" alt="" referrerpolicy="no-referrer" data-thumb></div>`
            : `<div class="mm-detail-cover"><div class="mm-ph">${esc(String(row.name).slice(0, 2))}</div></div>`;

        const kv = [
            [t('作者', 'Author'), esc(row.author || t('未署名', 'unattributed'))],
            row.owners.length > 0 ? [t('维护者', 'Maintainers'), esc(row.owners.join('、'))] : null,
            row.folia ? [t('需要 Folia', 'Needs Folia'), `<code>${esc(row.folia)}</code>`] : null,
            row.depends.length > 0 ? [t('依赖', 'Depends'), esc(row.depends.join('、'))] : null,
            row.download?.size ? [t('包大小', 'Package'), esc(formatSize(row.download.size))] : null,
            row.installedVersion ? [t('已安装', 'Installed'), esc(`v${row.installedVersion}${row.enabled ? t(' · 已启用', ' · enabled') : ''}`)] : null,
            [t('签名', 'Signature'), signature],
            row.signedAt ? [t('签名时间', 'Signed'), esc(formatTime(row.signedAt))] : null,
            row.download?.sha256 ? [t('包哈希', 'SHA-256'), `<code>${esc(row.download.sha256)}</code>`] : null,
        ].filter(Boolean);

        const links = [
            row.source ? `<a data-act="external" data-url="${esc(row.source)}">${esc(t('源码仓库', 'Source'))}</a>` : '',
            row.page ? `<a data-act="external" data-url="${esc(row.page)}">${esc(t('官网页面', 'Official page'))}</a>` : '',
            row.download ? `<a data-act="external" data-url="${esc(row.download.url)}">${esc(t('直接下载 zip', 'Download zip'))}</a>` : '',
        ].filter(Boolean).join(' · ');

        return (
            `<div class="mm-detail">` +
            `<div><button class="mm-btn is-small is-ghost" data-act="back">${SVG_BACK}${esc(t('返回市场', 'Back'))}</button></div>` +
            (errorRow ? errorRow : '') +
            `<div class="mm-detail-top">` + cover +
            `<div class="mm-detail-head">` +
            `<div class="mm-detail-name">${esc(row.name)}<span class="mm-ver">v${esc(row.version)}</span></div>` +
            `<div class="mm-detail-sub">${badgesOf(row).replace(/mm-tag/g, 'mm-pill')}</div>` +
            `<div class="mm-detail-actions">${action}</div>` +
            (links ? `<div class="mm-detail-sub">${links}</div>` : '') +
            `</div></div>` +
            `<div class="mm-section"><h4>${esc(t('说明', 'Description'))}</h4><div class="mm-desc">${esc(row.description)}</div></div>` +
            `<div class="mm-section"><h4>${esc(t('权限', 'Permissions'))}</h4>${perms}</div>` +
            experiments +
            `<div class="mm-section"><h4>${esc(t('信息', 'Details'))}</h4><dl class="mm-kv">${kv
                .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value}</dd>`)
                .join('')}</dl></div>` +
            `</div>`
        );
    };

    const headMetaHtml = () => {
        const catalog = state.catalog;
        const installedCount = state.installed.size;
        const updateCount = rows().filter((row) => row.hasUpdate).length;
        const pieces = [];

        if (catalog) {
            const where = catalog.source === 'network'
                ? t('刚刚从官方站读取', 'fetched from the official site')
                : t(`缓存于 ${relativeTime(catalog.fetchedAt)}`, `cached ${relativeTime(catalog.fetchedAt)}`);
            pieces.push(`<span>${esc(t(`共 ${catalog.mods.length} 个模组 · ${where}`, `${catalog.mods.length} mods · ${where}`))}</span>`);
        }
        pieces.push(`<span>${esc(t(`已装 ${installedCount} 个`, `${installedCount} installed`))}</span>`);
        if (updateCount > 0) {
            pieces.push(`<span style="color:var(--mm-ink)">${esc(t(`${updateCount} 个可更新`, `${updateCount} updates`))}</span>`);
        }
        if (catalog && catalog.stale && catalog.error) {
            pieces.push(`<span>${esc(t('离线：', 'Offline: '))}${esc(humanError(catalog.error))}</span>`);
        }
        pieces.push(`<a data-act="external" data-url="${esc(CATALOG_ORIGIN)}">${esc(t('在浏览器打开官方站', 'Open the official site'))}</a>`);
        return pieces.join('');
    };

    const paint = () => {
        if (!root || !body) return;
        if (headMeta) headMeta.innerHTML = headMetaHtml();
        body.innerHTML = state.view === 'detail' ? detailHtml() : listHtml();
        bindThumbs();
        if (toolbar) {
            toolbar.querySelectorAll('[data-filter]').forEach((element) => {
                element.classList.toggle('is-on', element.dataset.filter === state.filter);
            });
            const input = toolbar.querySelector('input[data-search]');
            if (input && input.value !== state.query) {
                input.value = state.query;
            }
            const refreshButton = toolbar.querySelector('[data-act="refresh"]');
            if (refreshButton) {
                refreshButton.disabled = state.loading;
            }
        }
    };

    const bindThumbs = () => {
        body?.querySelectorAll('img[data-thumb]').forEach((image) => {
            image.addEventListener(
                'error',
                () => {
                    const holder = image.parentElement;
                    if (!holder) return;
                    const fallback = document.createElement('div');
                    fallback.className = 'mm-ph';
                    fallback.textContent = '♪';
                    image.replaceWith(fallback);
                },
                { once: true }
            );
        });
    };

    const onBodyClick = (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
        if (!target) {
            const card = event.target instanceof Element ? event.target.closest('[data-card]') : null;
            if (card) {
                state.detailId = card.dataset.card;
                state.view = 'detail';
                body.scrollTop = 0;
                paint();
            }
            return;
        }
        const action = target.dataset.act;
        const id = target.dataset.id;

        if (action === 'refresh') {
            void refresh({ force: true });
            return;
        }
        if (action === 'back') {
            state.view = 'list';
            paint();
            return;
        }
        if (action === 'detail' && id) {
            state.detailId = id;
            state.view = 'detail';
            body.scrollTop = 0;
            paint();
            return;
        }
        if (action === 'external' && target.dataset.url) {
            event.preventDefault();
            openInBrowser(target.dataset.url);
            return;
        }
        if (action === 'open-dir') {
            void bridge()?.openModsDirectory?.();
            return;
        }
        if (action === 'update-all') {
            void updateAll();
            return;
        }
        if ((action === 'install' || action === 'enable') && id) {
            const row = rows().find((entry) => entry.id === id);
            if (!row) return;
            if (action === 'install') void install(row);
            else void enableOnly(row);
        }
    };

    const onToolbarClick = (event) => {
        const chip = event.target instanceof Element ? event.target.closest('[data-filter]') : null;
        if (chip) {
            state.filter = chip.dataset.filter || 'all';
            paint();
        }
    };

    const buildDom = (container, ctx) => {
        // 宿主重载模组时可能先挂新的再卸旧的：先把上一次留下的面板摘掉，避免叠两份。
        try {
            container.querySelectorAll('[data-mm-root]').forEach((node) => node.remove());
        } catch (_) {}

        root = document.createElement('div');
        root.className = 'mm-root';
        root.dataset.mmRoot = '1';

        const style = document.createElement('style');
        style.textContent = CSS;

        const head = document.createElement('div');
        head.className = 'mm-head';
        head.innerHTML =
            `<div class="mm-title">${esc(t('模组市场', 'Mod market'))}<small>${esc(
                t('官方站的全部模组，点安装就不用再走浏览器', 'Every mod from the official market, installable in place')
            )}</small></div>` +
            `<div class="mm-head-actions">` +
            `<button class="mm-btn is-small is-ghost" data-act="refresh" title="${esc(t('刷新市场', 'Refresh'))}">${SVG_REFRESH}${esc(t('刷新', 'Refresh'))}</button>` +
            `</div>` +
            `<div class="mm-meta"></div>`;

        toolbar = document.createElement('div');
        toolbar.className = 'mm-toolbar';
        toolbar.innerHTML =
            `<label class="mm-search">${SVG_SEARCH}<input type="search" data-search placeholder="${esc(
                t('搜索名称、作者、说明', 'Search name, author, description')
            )}" spellcheck="false"></label>` +
            `<div class="mm-chips">` +
            ['all', 'official', 'community', 'beta', 'installed']
                .map((key) => {
                    const label = {
                        all: t('全部', 'All'),
                        official: t('官方', 'Official'),
                        community: t('社区', 'Community'),
                        beta: 'Beta',
                        installed: t('已安装', 'Installed'),
                    }[key];
                    return `<button class="mm-chip${state.filter === key ? ' is-on' : ''}" data-filter="${key}">${esc(label)}</button>`;
                })
                .join('') +
            `</div>`;

        body = document.createElement('div');
        body.className = 'mm-body';

        headMeta = head.querySelector('.mm-meta');

        root.append(style, head, toolbar, body);
        container.appendChild(root);

        head.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
            if (!target) return;
            if (target.dataset.act === 'refresh') void refresh({ force: true });
            if (target.dataset.act === 'external' && target.dataset.url) {
                event.preventDefault();
                openInBrowser(target.dataset.url);
            }
        });
        toolbar.addEventListener('click', onToolbarClick);
        toolbar.addEventListener('input', (event) => {
            const input = event.target;
            if (input instanceof HTMLInputElement && input.dataset.search !== undefined) {
                state.query = input.value;
                paint();
            }
        });
        body.addEventListener('click', onBodyClick);

        // 主题：宿主可能给的是深色或浅色，颜色全部从 ctx.getTheme() 反推。
        const applyTheme = () => {
            if (!root) return;
            let theme = null;
            try {
                theme = ctx?.getTheme?.() ?? null;
            } catch (_) {
                theme = null;
            }
            if (!theme) return;
            const background = theme.backgroundColor || '#15151b';
            const ink = theme.primaryColor || '#e9e9ef';
            const muted = theme.secondaryColor || '#8b8b97';
            const accent = theme.accentColor || theme.primaryColor || '#b6a1f0';
            root.style.setProperty('--mm-ink', ink);
            root.style.setProperty('--mm-muted', muted);
            root.style.setProperty('--mm-accent', accent);
            root.style.setProperty('--mm-bg', background);
        };
        applyTheme();

        let offTheme = () => {};
        try {
            const subscribe = ctx?.onChange ?? ctx?.subscribe;
            if (typeof subscribe === 'function') {
                const handle = subscribe.call(ctx, applyTheme);
                offTheme = typeof handle === 'function' ? handle : () => {};
            }
        } catch (error) {
            warn(`主题订阅失败：${String(error?.message || error)}`);
        }

        const settings = readSettings();
        paint(); // 先落一个骨架，别让页面空白
        void refresh({ force: settings.autoCheck });

        return () => {
            try {
                offTheme();
            } catch (_) {}
            body?.removeEventListener('click', onBodyClick);
            toolbar?.removeEventListener('click', onToolbarClick);
            root?.remove();
            root = null;
            body = null;
            toolbar = null;
            headMeta = null;
            state.mounted = false;
        };
    };

    /* ----------------------------------------------------------- 注册入口 */

    const mount = (container, ctx) => {
        if (ctx?.locale) locale = ctx.locale;
        state.mounted = true;
        return buildDom(container, ctx);
    };

    const handles = [];

    try {
        const homeTabs = folium.registries?.homeTabs;
        if (homeTabs?.register) {
            handles.push(
                homeTabs.register({
                    id: 'market',
                    label: L('模组市场', 'Mod market'),
                    order: 900,
                    mount,
                })
            );
        } else if (folium.registries?.playerPanelTabs?.register) {
            // 老宿主没有首页标签页时退到播放器侧栏，至少还能用。
            handles.push(
                folium.registries.playerPanelTabs.register({
                    id: 'market',
                    label: L('模组市场', 'Mod market'),
                    order: 260,
                    mount,
                })
            );
        }
    } catch (error) {
        warn(`市场页面注册失败：${String(error?.message || error)}`);
    }

    try {
        handles.push(
            folium.registries?.commands?.register?.({
                id: 'open-market',
                label: L('打开模组市场', 'Open the mod market'),
                description: L('浏览官方模组市场，一键安装与更新模组', 'Browse the official mod market and install or update mods'),
                run: () => {
                    try {
                        folium.ui.openHomeTab('market');
                    } catch (error) {
                        const message = String(error?.message || error);
                        warn(`openHomeTab 失败：${message}`);
                        toast(t('这个宿主版本没有首页标签页，请从首页导航进入模组市场。', 'This host has no home tabs; open the market from the home navigation.'), 'error');
                    }
                },
            })
        );
    } catch (error) {
        warn(`命令注册失败：${String(error?.message || error)}`);
    }

    // 模组被停用 / 热重载时把注册项一个个还回去。
    return () => {
        handles.forEach((handle) => {
            try {
                handle?.unregister?.();
            } catch (_) {}
        });
        state.jobs.clear();
    };
}
