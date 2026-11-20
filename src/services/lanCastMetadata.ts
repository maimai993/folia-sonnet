// src/services/lanCastMetadata.ts
// 投送给音响时声明的媒体元数据该怎么写（issue M23）。
//
// 两个问题：
// 1. `protocolInfo` 过去写死成 `audio/mpeg` + `DLNA.ORG_PN=MP3`。投送源却可以是任意格式
//    —— 本地文件、无损流、别的平台直链都会走到这里 —— 而部分音响**按 protocolInfo 选解码器**，
//    声明与实际不符时直接拒播。这里按实际地址认格式，认不出来才回退 MP3。
// 2. 时长过去用 `Int` 承载毫秒，且 `String.format` 不带 Locale：阿拉伯语等区域的默认 Locale
//    会产出非 ASCII 数字，而 DLNA 的 `duration` 必须是 `H+:MM:SS` 的 ASCII 形式。
//    格式化放在原生（`LanCastMetadata.duration`，`Locale.ROOT`），这里只负责把毫秒送过去。

/** DLNA 认识的音频容器。`null` 表示认不出，调用方回退 MP3。 */
export type LanCastAudioFormat =
    | 'mp3'
    | 'flac'
    | 'alac'
    | 'aac'
    | 'm4a'
    | 'wav'
    | 'ogg'
    | 'opus';

type FormatSpec = {
    /** `<res protocolInfo>` 里的 MIME。 */
    mime: string;
    /** `DLNA.ORG_PN`；空串表示这个容器没有可声明的 profile（不写这一段）。 */
    pn: string;
};

/**
 * 各容器对应的声明。`m4a` / `aac` / `alac` 的 profile 都是 AAC_ISO，因为音响按 MIME 选解码器时
 * 只认这一族；写 flac / wav 这些则是成套的（MIME 与 profile 一致），不会互相矛盾。
 */
const FORMAT_SPECS: Record<LanCastAudioFormat, FormatSpec> = {
    mp3: { mime: 'audio/mpeg', pn: 'MP3' },
    flac: { mime: 'audio/flac', pn: 'FLAC' },
    alac: { mime: 'audio/mp4', pn: 'AAC_ISO' },
    aac: { mime: 'audio/mp4', pn: 'AAC_ISO' },
    m4a: { mime: 'audio/mp4', pn: 'AAC_ISO' },
    wav: { mime: 'audio/wav', pn: 'WAV' },
    ogg: { mime: 'audio/ogg', pn: 'OGG' },
    opus: { mime: 'audio/ogg', pn: 'OGG' },
};

/** 认不出格式时的回退：绝大多数音响都至少认 MP3。 */
const FALLBACK_MIME = 'audio/mpeg';

/**
 * 从地址里认格式。
 *
 * 地址上的扩展名优先（本地文件、直链都带）；带 enc / 中转参数的地址按参数里的 `type` / `format`
 * 认；都没有就看 MIME 参数。认不出返回 `null` —— 不猜，让调用方写 MP3 并让音响自己按内容判。
 */
export const detectLanCastAudioFormat = (url: string): LanCastAudioFormat | null => {
    const value = String(url ?? '').trim();
    if (!value) return null;
    // 参数里显式说了格式就以它为准：`/remote-audio/<token>?type=flac`。
    const fromQuery = formatFromQuery(value);
    if (fromQuery) return fromQuery;
    // 再看路径（忽略大小写；`.m4a?token=...` 这种先被上面的参数判断拦下过）。
    const path = pathOf(value);
    const match = /\.([a-z0-9]{2,5})$/i.exec(path);
    if (!match) return null;
    return FORMAT_BY_EXTENSION[match[1].toLowerCase()] ?? null;
};

const FORMAT_BY_EXTENSION: Record<string, LanCastAudioFormat> = {
    mp3: 'mp3',
    mp2: 'mp3',
    mpa: 'mp3',
    flac: 'flac',
    alac: 'alac',
    m4a: 'm4a',
    mp4: 'm4a',
    aac: 'aac',
    wav: 'wav',
    wave: 'wav',
    ogg: 'ogg',
    oga: 'ogg',
    opus: 'opus',
};

const formatFromQuery = (value: string): LanCastAudioFormat | null => {
    const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : '';
    if (!query) return null;
    const params = new URLSearchParams(query);
    for (const key of ['type', 'format', 'container', 'ext']) {
        const raw = params.get(key);
        if (!raw) continue;
        const lowered = raw.toLowerCase().replace(/^audio\//, '');
        const byMime = formatByMime(lowered);
        if (byMime) return byMime;
        const byExtension = FORMAT_BY_EXTENSION[lowered];
        if (byExtension) return byExtension;
    }
    return null;
};

const formatByMime = (mime: string): LanCastAudioFormat | null => {
    switch (mime.split(';')[0].trim()) {
        case 'mpeg':
        case 'mp3':
            return 'mp3';
        case 'flac':
        case 'x-flac':
            return 'flac';
        case 'mp4':
        case 'm4a':
        case 'x-m4a':
        case 'aac':
        case 'alac':
            return 'aac';
        case 'wav':
        case 'x-wav':
        case 'wave':
            return 'wav';
        case 'ogg':
        case 'opus':
        case 'x-ogg':
            return mime.includes('opus') ? 'opus' : 'ogg';
        default:
            return null;
    }
};

/** 地址里的路径部分；地址本身不合法时退化成「问号之前的那一段」。 */
const pathOf = (value: string): string => {
    try {
        return new URL(value).pathname;
    } catch {
        const cut = value.search(/[?#]/);
        return cut >= 0 ? value.slice(0, cut) : value;
    }
};

/**
 * 生成要交给音响的 `protocolInfo` 与格式名。
 *
 * 原生侧（`LanCastMetadata.protocolInfo`）有同一套映射：这次投送的地址在原生 `play` 里才最终
 * 定下来（回环地址要换成局域网地址），所以拿不到格式时由原生按地址再认一次，两边结果一致。
 * 认不出格式才回退 MP3：`http-get:*:audio/mpeg:*` 不带 profile 段，不替音响断定它是哪种 profile。
 */
export const describeLanCastMedia = (url: string): {
    format: LanCastAudioFormat | null;
    protocolInfo: string;
} => {
    const format = detectLanCastAudioFormat(url);
    if (!format) return { format: null, protocolInfo: `http-get:*:${FALLBACK_MIME}:*` };
    const spec = FORMAT_SPECS[format];
    // 没有可声明的 profile 时用 `*`，而不是编一个：乱写 profile 比不写更容易被音响拒。
    const pn = spec.pn ? `:DLNA.ORG_PN=${spec.pn}` : ':*';
    return { format, protocolInfo: `http-get:*:${spec.mime}${pn}` };
};

/** 元数据被裁剪的地方，要能传到界面上（issue M23 的第 3 点）。 */
export type LanCastMetadataTrim = 'cover' | 'album' | 'title' | 'artist';

/**
 * 哪些字段会被裁掉。
 *
 * 只按原生 `didlMetadata` 的规则算：封面不是 http(s)（本地 blob、`data:`、空）时整段不发，
 * 其余字段只做 XML 转义、不丢。返回的顺序固定，便于界面与测试对齐。
 */
export const describeLanCastTrimming = (track: {
    coverUrl?: string;
    album?: string;
    title?: string;
    artist?: string;
}): LanCastMetadataTrim[] => {
    const trimmed: LanCastMetadataTrim[] = [];
    const cover = String(track.coverUrl ?? '').trim();
    // `startsWith('http', true)` 与原生一致：`https://` 也算。空与 blob:/data: 都发不出去。
    if (!/^https?:\/\//i.test(cover)) trimmed.push('cover');
    if (!String(track.title ?? '').trim()) trimmed.push('title');
    if (!String(track.artist ?? '').trim()) trimmed.push('artist');
    if (!String(track.album ?? '').trim()) trimmed.push('album');
    return trimmed;
};
