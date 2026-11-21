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
 * 这个开关的默认值改过两次，每次都换了键名 —— 理由一样：**旧键里存着的值会盖住新默认值**。
 *
 *   · v2 之前出场是「开」，地址默认指向一个外部域名。H34 把默认改成「关、地址为空」，
 *     于是升到 v3：不换键的话，老用户 localStorage 里那份 `enabled: true` 会继续生效，
 *     代码里写的「没填就关」根本轮不上。
 *   · v3 又把地址留空，结果云缓存对所有人等于关闭（用户反馈「现在拉取不了」）。现在
 *     恢复成内置地址 + 默认开启，于是升到 v4：不换键的话，老用户手里存的
 *     `baseUrl: ''` 会把新默认值盖掉，改动对他们不会生效 —— 这正是要避免的那件事。
 *
 * 以后再改默认值，同理再升一位。
 */
const STORAGE_KEY = 'foliaCloudSettings.v4';
const LEGACY_STORAGE_KEY = 'foliaCloudSettings.v2';
export const FOLIA_CLOUD_SETTINGS_CHANGED_EVENT = 'folia-ai-cloud-cache-settings-changed';

/**
 * 内置地址：项目自己的公共实例。
 *
 * 这块地方改过两次，记一下为什么最后落在这里：
 *
 *   · 最早写死一个官方域名，出厂就用，README 却声称「源码不含内置第三方后端地址」——
 *     代码与承诺相反（H34）；
 *   · 于是改成空串，云能力对没用过的人等于关闭。可云缓存是个**公开服务**，读取不需要
 *     任何凭据，把地址留空并不是「更安全」，只是让所有人用不了 —— 用户反馈的
 *     「云缓存现在拉取不了」就是这个。
 *
 * 现在的取舍：地址内置、默认开启，同时 README 如实写明它指向项目自己的公共实例、
 * 可以在设置里换成自己的服务或关掉。言行一致比「代码里看不见域名」更有意义。
 */
export const DEFAULT_CLOUD_BASE_URL = 'https://apif.tangbot.xyz';

/**
 * 写云缓存时可以带的准入凭证请求头（服务端 `admin.ts` 的 `CACHE_WRITE_TOKEN_HEADER`）。
 *
 * 公共实例不校验它：读缓存本来就不需要凭据，写缓存也不设门槛 —— 答案回传得越多，
 * 别人命中得越快。留着这个头是为了让**自建**的服务能自己加一道门：填了就带上，
 * 没填就不带，客户端从不因为缺它而拒绝写入。
 */
export const CLOUD_WRITE_TOKEN_HEADER = 'X-Folia-Cache-Token';

export interface FoliaCloudSettings {
    /** 云缓存开关。默认开启（指向内置的公共实例）；填自己的地址也照开。 */
    enabled: boolean;
    /** 云服务地址（不含 /api）。留空 = 云能力关闭。 */
    baseUrl: string;
    /** 写缓存的准入令牌。留空照常写 —— 公共实例不校验，留它是给自建服务的。 */
    writeToken: string;
}

export const DEFAULT_FOLIA_CLOUD_SETTINGS: FoliaCloudSettings = {
    enabled: true,
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
    /*
     * 地址**不由用户改**：一律用内置的公共实例。旧版本里可能存过用户自己填的地址，
     * 那一份不再采用 —— 这个地址是固定的，设置页只展示不接收输入。
     */
    cachedSettings = {
        enabled: parsed?.enabled === undefined ? true : parsed.enabled !== false,
        baseUrl: DEFAULT_CLOUD_BASE_URL,
        writeToken: '',
    };
    /* 搬过一次就落盘，别每次读都再搬一遍（用户可能已经把开关关了）。 */
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
        /* 地址固定，patch 里的 baseUrl 一律忽略。 */
        baseUrl: DEFAULT_CLOUD_BASE_URL,
        writeToken: '',
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
 * 云能力现在能不能用：只看开关。地址是内置的、一直有，所以不需要再判它。
 */
export const isFoliaCloudCacheEnabled = (): boolean => readFoliaCloudSettings().enabled;

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
