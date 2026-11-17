import { fetchJsonWithRetry } from '../utils/fetchWithTimeout';
import {
  downloadUpdate,
  installUpdate,
  isNativeHttpAvailable,
  nativeGetText,
  watchUpdateDownloadProgress,
  type UpdateDownloadProgress,
} from '../platform/foliaNative';

// src/services/appUpdate.ts
// 应用内检查更新（Android）。
//
// 版本清单是一份静态 json，形如：
//   { "version": "0.7.19", "download_url": "https://.../folia-sonnet-0.7.19-release.apk" }
// 出包时把最新版本号与安装包地址写进去即可 —— 不依赖 GitHub Release，也绕开 API 限流。
//
// 桌面端那套走 electron-updater（主进程里查、下载、重启安装），Android 这里没有对应能力：
// 应用**不允许**自己静默装更新，非 Play 分发必须落到系统安装器并让用户点确认。所以这条
// 链路是：拉清单 → 比版本号 → 原生下载（带进度）→ 下完弹「立即安装」。
//
// 版本号来源是编译期注入的 `__APP_VERSION__`（vite.config.ts 从 package.json 读），
// 和清单里的 version 直接对齐。

/** 版本清单地址。 */
export const APP_UPDATE_MANIFEST_URL = 'https://cdn.tangbot.xyz/update.json';

/** 打开发布页的兜底入口：清单里给了 page_url 就用清单的。 */
export const APP_UPDATE_RELEASES_PAGE = `https://github.com/Folia-CE/folia-sonnet/releases`;

/**
 * 请求超时。检查更新是个后台动作，网络对不上时不该让用户对着转圈等，
 * 超时后界面给的是一条能看懂的失败原因 + 手动入口。
 */
const REQUEST_TIMEOUT_MS = 12_000;

/** update.json 里我们用到的字段：只有 version 与 download_url 是必需的。 */
type UpdateManifestPayload = {
  version?: string;
  download_url?: string;
  /** Release 页面地址（可选）。 */
  page_url?: string;
  /** 更新日志（可选）。 */
  notes?: string;
  published_at?: string;
  /** 包体积（可选，用于显示下载大小）。 */
  size?: number;
  /** 多产物（可选）：给了就按后缀挑 apk / aab。 */
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    size?: number;
  }>;
};

export type AppReleaseAsset = {
  name: string;
  /** 直接下载地址：发给系统浏览器就是一次下载。 */
  downloadUrl: string;
  sizeBytes: number;
};

export type AppReleaseInfo = {
  /** 去掉 v 前缀的版本号，例如 0.7.19；标签不带版本号时退回标签本身。 */
  version: string;
  /** 原始标签，例如 v0.7.19。 */
  tag: string;
  /** Release 标题（可能为空）。 */
  name: string;
  /** Release 页面地址，供「打开发布页」使用。 */
  pageUrl: string;
  /** Release 正文（更新日志）。 */
  notes: string;
  publishedAt: string | null;
  apk: AppReleaseAsset | null;
  aab: AppReleaseAsset | null;
};

export type AppUpdateCheckResult =
  | { status: 'update-available'; currentVersion: string; release: AppReleaseInfo }
  | { status: 'up-to-date'; currentVersion: string; release: AppReleaseInfo }
  | { status: 'failed'; currentVersion: string; message: string };

/**
 * 当前应用版本。
 *
 * `__APP_VERSION__` 是 vite 的 define 注入的全局常量，在 vitest / node 环境下不存在，
 * 所以一律带 typeof 判断（仓库里其它读它的地方也是这个写法）。
 */
export const getCurrentAppVersion = (): string => (
  typeof __APP_VERSION__ === 'undefined' ? '0.0.0' : String(__APP_VERSION__)
);

type ParsedVersion = {
  /**
   * 版本号数字段，缺失的按 0 补齐。
   *
   * 第四段是给 `0.7.19.1` 这种**四位版本号**留的（strict semver 只认三段，但
   * 应用侧一直在用四位）。只认三段的话它会被判成「解析不了」而退回字符串比较 ——
   * 字符串比较在 `0.7.9` vs `0.7.19` 这种位数不同的地方就会比错方向。
   */
  numbers: [number, number, number, number];
  /** 预发布标识（`-beta.1` 里的 `beta.1`）；正式版为 null。 */
  prerelease: string | null;
};

/**
 * 解析版本号。认 `[v]X[.Y][.Z][.W][-pre][+build]` 这种形状。
 * build 元数据（`+build.7`）直接丢掉 —— 它不参与比较，而 semver 规定带它的版本
 * 与不带它的**相等**，当成预发布标识会让「0.7.19+build.7」被误判成比 0.7.19 旧。
 */
export const parseAppVersion = (value: string): ParsedVersion | null => {
  const trimmed = value.trim().replace(/^v/i, '');
  const matched = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!matched) return null;
  return {
    numbers: [
      Number(matched[1] ?? 0),
      Number(matched[2] ?? 0),
      Number(matched[3] ?? 0),
      Number(matched[4] ?? 0),
    ],
    prerelease: matched[5] ?? null,
  };
};

/**
 * 比较版本号：a > b 返回正数，a < b 返回负数，相等返回 0。
 *
 * 预发布排在同一个正式版**之前**（0.7.19-beta.1 < 0.7.19），这是 semver 的约定，
 * 也正好是我们需要的行为：装了 beta 的人应该能收到正式版的更新提示。
 * 两个都是预发布时按标识逐段比（数字段按数值比），比不出来就当相等 —— 宁可漏一次
 * 提示，也不要因为比错方向把人从新版赶回旧版。
 */
export const compareAppVersions = (a: string, b: string): number => {
  const left = parseAppVersion(a);
  const right = parseAppVersion(b);
  if (!left || !right) {
    // 解析不了就按字符串比，至少不会崩。
    return a === b ? 0 : a > b ? 1 : -1;
  }

  for (let index = 0; index < left.numbers.length; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] - right.numbers[index];
    }
  }

  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const leftParts = left.prerelease.split('.');
  const rightParts = right.prerelease.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) continue;
    // 段数少的那个更小（beta < beta.1）。
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const bothNumeric = !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber);
    if (bothNumeric && leftNumber !== rightNumber) return leftNumber - rightNumber;
    if (!bothNumeric) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
};

/**
 * 解析产物后缀名。`folia-sonnet-0.7.19-release.apk` → `apk`。
 * 带查询串的地址也认（GitHub 的 browser_download_url 不带，但别的地方可能带）。
 */
const assetExtensionOf = (name: string): string => {
  const withoutQuery = name.split('?')[0];
  const dot = withoutQuery.lastIndexOf('.');
  return dot === -1 ? '' : withoutQuery.slice(dot + 1).toLowerCase();
};

/**
 * 从 Release 的产物里挑出要装的那一个。
 *
 * 只按后缀挑，不认文件名格式：CI 现在叫 `folia-sonnet-<version>-release.apk`，
 * 但名字会变（换版本号拼法、加渠道后缀），而后缀不会。同一后缀有多个时优先带
 * `release` 的，其次取体积大的（真正的安装包总比校验文件大）。
 */
export const pickReleaseAsset = (
  assets: Array<{ name?: string; browser_download_url?: string; size?: number }> | undefined,
  extension: string,
): AppReleaseAsset | null => {
  const candidates = (assets ?? [])
    .filter((asset): asset is { name: string; browser_download_url: string; size?: number } => (
      typeof asset?.name === 'string'
      && typeof asset.browser_download_url === 'string'
      && assetExtensionOf(asset.name) === extension
    ));
  if (candidates.length === 0) return null;

  const preferred = candidates.filter(asset => /release/i.test(asset.name));
  const pool = preferred.length > 0 ? preferred : candidates;
  const chosen = pool.reduce((best, asset) => ((asset.size ?? 0) > (best.size ?? 0) ? asset : best));
  return {
    name: chosen.name,
    downloadUrl: chosen.browser_download_url,
    sizeBytes: chosen.size ?? 0,
  };
};

/** 从下载地址里取文件名：`.../folia-sonnet-0.7.19-release.apk?x=1` → `folia-sonnet-0.7.19-release.apk`。 */
const fileNameOf = (url: string): string => {
  const withoutQuery = url.split(/[?#]/)[0];
  const slash = withoutQuery.lastIndexOf('/');
  const name = slash === -1 ? withoutQuery : withoutQuery.slice(slash + 1);
  return name || 'folia-update.apk';
};

const nonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null
);

const toReleaseInfo = (payload: UpdateManifestPayload): AppReleaseInfo | null => {
  const rawVersion = nonEmptyString(payload.version);
  if (!rawVersion) return null;
  const version = rawVersion.replace(/^v/i, '');

  const downloadUrl = nonEmptyString(payload.download_url) ?? '';
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  // 清单给了 assets 就按后缀挑；否则把 download_url 当安装包，但只认 .apk ——
  // .aab 装不上，宁可报「没有可用安装包」也别让人白下一遍。
  const apk = pickReleaseAsset(assets, 'apk')
    ?? (assetExtensionOf(downloadUrl) === 'apk'
      ? { name: fileNameOf(downloadUrl), downloadUrl, sizeBytes: Number(payload.size) || 0 }
      : null);

  return {
    version,
    tag: rawVersion,
    name: '',
    pageUrl: nonEmptyString(payload.page_url) ?? APP_UPDATE_RELEASES_PAGE,
    notes: nonEmptyString(payload.notes) ?? '',
    publishedAt: nonEmptyString(payload.published_at),
    apk,
    aab: pickReleaseAsset(assets, 'aab'),
  };
};

/** 把失败原因翻成人话。「检查失败」这三个字本身不足以让人判断该不该重试。 */
const describeFetchFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 4(03|04)/.test(message)) {
    // 403/404 = 清单地址变了或文件没传上去。
    return 'manifest-missing';
  }
  if (/timed out|AbortError/i.test(message)) {
    return 'timeout';
  }
  return message;
};

/**
 * 取一次版本清单。
 *
 * 安卓上优先走原生 OkHttp 桥：自建 CDN（cdn.tangbot.xyz）不回 `Access-Control-Allow-Origin`，
 * WebView 里的 fetch 会被同源策略直接拦掉，表现就是「一直检查失败」。原生侧没有这个限制。
 * 桥也没拿到时再退回全局 fetch，好让失败原因是真实的 HTTP 状态而不是一句「桥不可用」。
 */
const fetchUpdateManifest = async (signal?: AbortSignal): Promise<UpdateManifestPayload> => {
  if (isNativeHttpAvailable()) {
    try {
      const text = await nativeGetText(APP_UPDATE_MANIFEST_URL, REQUEST_TIMEOUT_MS);
      return JSON.parse(text) as UpdateManifestPayload;
    } catch {
      // 落到下面的 fetch。
    }
  }
  return fetchJsonWithRetry<UpdateManifestPayload>(
    APP_UPDATE_MANIFEST_URL,
    {
      signal,
      // CDN 上可能留着上一版清单，带 no-store 拿最新的；缓存由 CDN 自己在边缘管。
      cache: 'no-store',
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
};

/**
 * 检查更新。
 *
 * 拉一次 update.json，比版本号。清单里少字段不报错（version 与 download_url 之外的都是
 * 可选），但拿不到可装的 apk 会明确报出来 —— 静默不给下载按钮只会让人以为没更新。
 *
 * 请求失败不抛异常 —— 界面要的是一条能展示的失败原因 + 手动入口，不是一次未捕获拒绝。
 */
export const checkForAppUpdate = async (signal?: AbortSignal): Promise<AppUpdateCheckResult> => {
  const currentVersion = getCurrentAppVersion();
  try {
    const payload = await fetchUpdateManifest(signal);

    const release = toReleaseInfo(payload ?? {});
    if (!release) {
      return { status: 'failed', currentVersion, message: 'empty-manifest' };
    }
    if (!release.apk) {
      return { status: 'failed', currentVersion, message: 'no-apk' };
    }

    return compareAppVersions(release.version, currentVersion) > 0
      ? { status: 'update-available', currentVersion, release }
      : { status: 'up-to-date', currentVersion, release };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error; // 调用方主动取消不算失败。
    }
    return { status: 'failed', currentVersion, message: describeFetchFailure(error) };
  }
};

// ---- 下载安装包 ----

/** 进度类型由原生桥那层定义（见 platform/foliaNative.ts），这里转出去，界面只认这一个入口。 */
export type { UpdateDownloadProgress };

export type UpdateDownloadOutcome = {
  /** 下载好的 APK 绝对路径，交给 installUpdateApk。 */
  path: string;
  bytes: number;
};

/** 监听下载进度，返回用来摘掉监听的 handle。 */
export const onUpdateDownloadProgress = (
  listener: (progress: UpdateDownloadProgress) => void,
): Promise<{ remove: () => Promise<void> }> => (
  watchUpdateDownloadProgress(listener)
);

/** 下载某个版本的安装包。文件名里带版本号，避免多个版本互相覆盖。 */
export const downloadUpdateApk = async (
  downloadUrl: string,
  version: string,
): Promise<UpdateDownloadOutcome> => {
  const fileName = `folia-sonnet-${version}.apk`;
  try {
    const result = await downloadUpdate({ url: downloadUrl, fileName });
    const path = typeof result?.path === 'string' ? result.path : '';
    if (!path) throw new Error('Update download returned no file path');
    return { path, bytes: Number(result?.bytes) || 0 };
  } catch (error) {
    throw new Error(describeDownloadFailure(error));
  }
};

/** 拉起系统安装器装下载好的包。 */
export const installUpdateApk = async (path: string): Promise<UpdateInstallOutcome> => {
  if (!path) throw new Error('no-file');
  try {
    const result = await installUpdate({ path });
    return { status: result?.status === 'permission-required' ? 'permission-required' : 'installing' };
  } catch (error) {
    throw new Error(describeDownloadFailure(error));
  }
};

export type UpdateInstallOutcome = {
  /**
   * `installing`：已经把包交给系统安装器，界面弹的是系统那张确认页。
   * `permission-required`：Android O+ 上「允许来自此来源的应用」还没开，已经跳了设置页 ——
   * 用户回来后再点一次「立即安装」即可，这点要在界面上说清楚。
   */
  status: 'installing' | 'permission-required';
};

/** 下载/安装失败的原因。和检查那边的错误码分开：成因不同，给用户的建议也不同。 */
const describeDownloadFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|AbortError/i.test(message)) return 'download-timeout';
  if (/HTTP 4(03|04)/.test(message)) return 'download-http-error';
  if (/ENOSPC|No space/i.test(message)) return 'download-no-space';
  if (/not shareable|FileProvider/i.test(message)) return 'download-file-error';
  return 'download-failed';
};
