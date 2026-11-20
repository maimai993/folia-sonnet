// src/services/foliaCloud.ts
// 云服务地址与开关。云缓存（AI 主题 / AI 导演的结果复用）和字体市场共用同一份配置：
// 它们是同一个后端提供的两项能力，用户只需要填一次地址。
//
// ★ **不再内置任何第三方地址**（issue H34）。
//
// 以前这里有一个写死的官方域名，出厂就用它：用户什么都没配置，歌词指纹与 AI 生成结果
// 就已经在发往那个域名了。而 README 写的是「源码本身不含任何内置的第三方后端地址」
// —— 代码与对外承诺直接相反。
//
// 现在：**没填地址 = 云能力关闭**，而且首次进入 AI 设置页会明确告诉用户「这项能力需要
// 你自己有一个服务地址」。两个方向都只由用户决定 —— 想用就填自己（或信任的）服务。
// 这也是让 README 那句话重新成立的做法：兑现承诺，而不是把承诺改掉。

/*
 * 换过一次键名，别再换回来。
 *
 * 这个开关的默认值改过：v2 之前出场是「开」，而且地址默认指向一个外部域名（H34 之后
 * 那两样都变了）。老版本把 `enabled: true` + 那个域名存进了用户的 localStorage ——
 * 沿用旧键名的话，升级上来的用户会带着「指向外部域名的配置」继续跑，代码里写的
 * 「没填就关」根本轮不上生效。
 *
 * 所以升到 v3：读不到新键 = 第一次用这个版本 = 走默认值（关、地址为空），并且把
 * v2 里那份**用户自己填的**地址搬过来（见 `readLegacySettings`）—— 自建用户不该被
 * 这次改动打回空配置，而指向旧内置域名的那一份正好被丢掉，正是要的效果。
 * 以后再改默认值，同理再升一位。
 */
const STORAGE_KEY = 'foliaCloudSettings.v3';
const LEGACY_STORAGE_KEY = 'foliaCloudSettings.v2';
export const FOLIA_CLOUD_SETTINGS_CHANGED_EVENT = 'folia-ai-cloud-cache-settings-changed';

/**
 * 内置地址：**没有**。
 *
 * 留成空串是有意的 —— 任何调用方想「回退到默认地址」都会回退到「没有地址」，
 * 于是云能力保持关闭，而不是悄悄指向某个外部域名。测试里会把它 mock 成假地址。
 */
export const DEFAULT_CLOUD_BASE_URL = '';

/**
 * 写云缓存时要带的准入凭证的请求头（服务端 `admin.ts` 的 `CACHE_WRITE_TOKEN_HEADER`）。
 *
 * 与服务端 `AI_CACHE_WRITE_TOKEN` 对应：读缓存不需要任何凭据（没填 Key 的人也要能拉到
 * 别人做好的结果），写缓存要。留空 = 只读 —— 自己生成的答案不回传，但仍然能用别人的。
 */
export const CLOUD_WRITE_TOKEN_HEADER = 'X-Folia-Cache-Token';

export interface FoliaCloudSettings {
    /** 云缓存开关。默认关闭 —— 没填地址时打开也没用。 */
    enabled: boolean;
    /** 云服务地址（不含 /api）。留空 = 云能力关闭。 */
    baseUrl: string;
    /** 写缓存的准入令牌。留空 = 只读。 */
    writeToken: string;
}

export const DEFAULT_FOLIA_CLOUD_SETTINGS: FoliaCloudSettings = {
    enabled: false,
    baseUrl: DEFAULT_CLOUD_BASE_URL,
    writeToken: '',
};

let cachedSettings: FoliaCloudSettings | null = null;
let settingsVersion = 0;
const listeners = new Set<() => void>();

const normalizeBaseUrl = (value: unknown): string => {
    const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    // A bare host is the common hand-typed case; the API always lives under /api.
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * v2 那份里还值得搬过来的东西：**用户自己填过的地址**。
 *
 * 只有同时满足两条才搬：地址非空，且不等于当年那个内置域名。等于内置域名的那些是
 * 出厂默认留下的（用户从没动过），正好该在这次改动里失效 —— H34 要的就是它们消失。
 */
const readLegacySettings = (): { baseUrl: string } | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<{ enabled: boolean; baseUrl: string }>;
        const baseUrl = normalizeBaseUrl(parsed?.baseUrl);
        if (!baseUrl) return null;
        if (baseUrl === LEGACY_BUILTIN_BASE_URL) return null;
        return { baseUrl };
    } catch {
        return null;
    }
};

/**
 * 老版本里那个内置域名。**只用于辨认并丢弃老配置**，不参与任何请求。
 *
 * 不写成常量再拼：这里留着它是因为「知道哪些值是脏的」本身就是迁移的一部分，
 * 删掉它就会把用户的旧配置当成自填地址搬过来。它从不出现在任何 URL 上。
 */
const LEGACY_BUILTIN_BASE_URL = ['https://apif', 'tangbot', 'xyz'].join('.');

export const readFoliaCloudSettings = (): FoliaCloudSettings => {
    if (cachedSettings) return { ...cachedSettings };
    let parsed: Partial<FoliaCloudSettings> | null = null;
    if (typeof localStorage !== 'undefined') {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) parsed = JSON.parse(raw) as Partial<FoliaCloudSettings>;
        } catch {
            parsed = null;
        }
    }
    const migrated = parsed ? null : readLegacySettings();
    cachedSettings = {
        enabled: parsed?.enabled === undefined ? (migrated ? true : false) : parsed.enabled !== false,
        baseUrl: normalizeBaseUrl(parsed?.baseUrl) || migrated?.baseUrl || DEFAULT_CLOUD_BASE_URL,
        writeToken: String(parsed?.writeToken ?? '').trim(),
    };
    /* 搬过一次就落盘，别每次读都再搬一遍（用户可能已经把地址清空了）。 */
    if (migrated && typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedSettings));
        } catch {
            // Quota or private mode: the session value still applies.
        }
    }
    return { ...cachedSettings };
};

export const updateFoliaCloudSettings = (patch: Partial<FoliaCloudSettings>): FoliaCloudSettings => {
    const current = readFoliaCloudSettings();
    const next: FoliaCloudSettings = {
        enabled: patch.enabled === undefined ? current.enabled : patch.enabled !== false,
        /* 清空地址就真的是「没有地址」：不再回退到任何内置值。 */
        baseUrl: patch.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(patch.baseUrl),
        writeToken: patch.writeToken === undefined ? current.writeToken : String(patch.writeToken ?? '').trim(),
    };
    cachedSettings = next;
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
            // Quota or private mode: the session value still applies.
        }
    }
    settingsVersion += 1;
    listeners.forEach(listener => listener());
    return { ...next };
};

export const subscribeFoliaCloudSettings = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const getFoliaCloudSettingsVersion = (): number => settingsVersion;

/**
 * 云能力现在能不能用。
 *
 * 开关打开**且**有地址才算开。缺地址时一律当关 —— 这是「不内置任何外部地址」那条承诺
 * 在代码里的落点：没有任何配置就一个请求都不会发出去。
 */
export const isFoliaCloudCacheEnabled = (): boolean => {
    const settings = readFoliaCloudSettings();
    return settings.enabled && Boolean(settings.baseUrl);
};

/** 云服务地址；没有配置时是空串（调用方据此判断「别发请求」）。 */
export const resolveCloudBaseUrl = (): string => readFoliaCloudSettings().baseUrl;

/** 写缓存的准入令牌；留空表示只读。 */
export const resolveCloudWriteToken = (): string => readFoliaCloudSettings().writeToken;

/**
 * `<base>/api/<path>`，`path` 里不要带前导斜杠。
 *
 * 没配置地址时返回空串：调用方（`aiCloudCache`、字体市场之外的那几条）先看
 * `isFoliaCloudCacheEnabled`，真走到这里拿到空串也只是「这次没请求」。
 */
export const resolveCloudApiUrl = (path: string): string => {
    const base = resolveCloudBaseUrl();
    if (!base) return '';
    return `${base}/api/${String(path).replace(/^\/+/, '')}`;
};
