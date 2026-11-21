// test/unit/contracts/wallpaperOverlayContract.test.ts
// 桌面歌词叠层的原生 → 页面数据通道（issue C4）。
//
// 这条通道是 `evaluateJavascript` 把一段 JSON 塞进页面里的全局函数，两端分别用
// Kotlin（WallpaperOverlay.buildPayload 手写 put）和 TypeScript（wallpaperSurfaceTypes
// 的 declare global）描述同一份 payload。**中间没有任何东西约束它们**：Kotlin 改个字段名、
// TS 这边没跟，编译都不报错，线上表现是「歌词不显示 / 封面不更新」，排查得同时读两侧源码。
//
// 这个用例从 Kotlin 源码里把字段名抽出来，和 TS 的类型逐条对照：
//   · Kotlin 推了、TS 没声明的字段 —— 页面读不到，属于漂移，红；
//   · TS 声明了、Kotlin 不推的字段 —— 本身不算错（封面 / 音频 / 群唱各有独立通道），
//     但**必须登记**在下面的 KNOWN_SEPARATE_CHANNELS 里，免得哪天有人以为它走整包。
//
// 更根本的做法是让两端共用一份定义再生成代码；在那之前，这条用例是唯一的护栏。

import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const KOTLIN_PATH = path.resolve(
    'android/app/src/main/java/top/izuna/foliamajor/wallpaper/WallpaperOverlay.kt',
);

/**
 * 走**独立通道**的字段：不跟着整包推送，所以 Kotlin 的 buildPayload 里没有它们。
 *
 * 每一条都要写清是哪条通道 —— 不写就没法判断以后加字段时该不该放进来。
 */
const KNOWN_SEPARATE_CHANNELS: Record<string, string> = {
    cover: '__foliaWallpaperPushCover（封面单独一条，避免被整包签名去重吞掉）',
    coverUrl: '__foliaWallpaperPushCover（同上）',
    cappellaAvatarImages: '__foliaWallpaperPushCappellaImages（几百 KB 的 base64，不能跟着整包走）',
    cappellaEmojiImages: '__foliaWallpaperPushCappellaImages（同上）',
    power: '__foliaWallpaperPushAudio（每秒 20 次的连续流）',
    bass: '__foliaWallpaperPushAudio（同上）',
    lowMid: '__foliaWallpaperPushAudio（同上）',
    mid: '__foliaWallpaperPushAudio（同上）',
    vocal: '__foliaWallpaperPushAudio（同上）',
    treble: '__foliaWallpaperPushAudio（同上）',
    /* 整包里没有，是页面自己算的：把绝对位置换算成「当前在第几行」。 */
    firstIndex: '页面自己推算（由 positionMs + lines 得出），原生不推',
};

/** 从 Kotlin 的 buildPayload() 里抽出 `out.put("字段"` 的名字。 */
const kotlinPayloadFields = (): string[] => {
    const source = fs.readFileSync(KOTLIN_PATH, 'utf8');
    const start = source.indexOf('private fun buildPayload(): String?');
    expect(start, 'WallpaperOverlay.kt 里找不到 buildPayload，契约测试的前提没了').toBeGreaterThan(-1);
    const rest = source.slice(start + 10);
    const end = rest.indexOf('\n    private fun ');
    const body = end > 0 ? rest.slice(0, end) : rest;
    return [...body.matchAll(/out\.put\("([A-Za-z0-9_]+)"/g)].map(match => match[1]);
};

/** 从 TS 的 `export type WallpaperPayload = { ... }` 里抽出字段名。 */
const typescriptPayloadFields = (): string[] => {
    const source = fs.readFileSync(
        path.resolve('src/entries/wallpaperSurfaceTypes.ts'),
        'utf8',
    );
    const start = source.indexOf('export type WallpaperPayload = {');
    expect(start, 'wallpaperSurfaceTypes.ts 里找不到 WallpaperPayload').toBeGreaterThan(-1);
    const rest = source.slice(start);
    const end = rest.indexOf('\n};');
    const body = rest.slice(0, end > 0 ? end : rest.length);
    /*
     * 只取一层：顶格缩进 4 个空格、可选的 `?`、然后是冒号。嵌套对象的字段缩进更深，
     * 不会被算进来 —— 那一层由它自己的类型管，不在整包的契约里。
     */
    return [...body.matchAll(/^\s{4}([A-Za-z0-9_]+)\??:/gm)].map(match => match[1]);
};

describe('桌面歌词叠层的 payload 契约（issue C4）', () => {
    it('Kotlin 推的每个字段，页面的 WallpaperPayload 都有声明', () => {
        const kotlin = kotlinPayloadFields();
        const ts = typescriptPayloadFields();
        /* 先确认两边都真读到了东西，否则「没有缺项」是假的。 */
        expect(kotlin.length).toBeGreaterThan(8);
        expect(ts.length).toBeGreaterThan(8);

        const missing = kotlin.filter(field => !ts.includes(field));
        expect(
            missing,
            `这些字段 Kotlin 推了但页面没声明，页面上会读不到：${missing.join(', ')}`,
        ).toEqual([]);
    });

    it('页面声明但 Kotlin 不推的字段，必须是登记过的独立通道', () => {
        const kotlin = kotlinPayloadFields();
        const ts = typescriptPayloadFields();

        const unexplained = ts
            .filter(field => !kotlin.includes(field))
            .filter(field => !(field in KNOWN_SEPARATE_CHANNELS));

        expect(
            unexplained,
            '这些字段页面声明了、整包里却没有，也没登记是哪条独立通道 —— '
            + '要么 Kotlin 漏推了，要么该登记进 KNOWN_SEPARATE_CHANNELS：'
            + unexplained.join(', '),
        ).toEqual([]);
    });

    /*
     * 反向：登记表本身不能烂掉。某个字段后来改成走整包了（或整个从 TS 里删了），
     * 它还留在 KNOWN_SEPARATE_CHANNELS 里就是过期文档，会误导下一个人。
     *
     * 注意不能用「页面整包里有没有它」来判：独立通道的字段本来就不在整包里
     * （power / bass 在 WallpaperAudioPayload 里），那才是正常的。
     */
    it('独立通道登记表里没有过期项', () => {
        const kotlin = kotlinPayloadFields();
        const source = fs.readFileSync(
            path.resolve('src/entries/wallpaperSurfaceTypes.ts'),
            'utf8',
        );

        const stale = Object.keys(KNOWN_SEPARATE_CHANNELS).filter(
            // 进了整包：登记项该删（它不再是独立通道）。
            field => kotlin.includes(field)
                // 或者整个 TS 文件里都没有这个字段了：它被删了，登记项也就没意义。
                || !new RegExp(`\\b${field}\\??:`, 'm').test(source),
        );
        expect(
            stale,
            '这些登记项已经过期（要么进了整包，要么页面也不再声明）：' + stale.join(', '),
        ).toEqual([]);
    });

    /*
     * 转义：payload 必须由 JSONObject 序列化后直接嵌进 JS，不能手拼。
     * `JSONObject.toString()` 产出的是合法 JSON，嵌进 JS 表达式是安全的 ——
     * 而手拼字符串只要多一个引号就会把整条指令截断，且 evaluateJavascript 不报错。
     */
    it('payload 用 JSONObject 序列化，不是手拼字符串', () => {
        const source = fs.readFileSync(KOTLIN_PATH, 'utf8');
        const start = source.indexOf('private fun buildPayload(): String?');
        const rest = source.slice(start + 10);
        const end = rest.indexOf('\n    private fun ');
        const body = end > 0 ? rest.slice(0, end) : rest;

        expect(body).toMatch(/val out = JSONObject\(\)/);
        expect(body).toMatch(/return out\.toString\(\)/);
    });
});
