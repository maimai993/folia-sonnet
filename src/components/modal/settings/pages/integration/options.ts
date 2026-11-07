import { option, type SettingsGroupDef } from '../../kit';
import { isCapacitorAndroid } from '../../../../../platform/runtime';
import { peekColorOsLyricsSupport } from '../../../../../platform/foliaColorOsLyrics';

// src/components/modal/settings/pages/integration/options.ts
// The groups and options of the 连接与集成 page, declared apart from the page so the files that
// draw its rows name the same ones. The ids other code opens the settings on (navidrome, r2Sync,
// discordRichPresence, scrobbleSettings, obsBrowserSource, lyricApi, stageMode) are rows here.

export const SERVICES: SettingsGroupDef = { id: 'services', titleKey: 'options.settingsHeadingServices' };
/**
 * 洛雪音源（fork 独有）：导入的脚本负责「取播放地址与歌词」，与那几家平台是同一层的东西 ——
 * 所以它跟 navidrome、同步服务一样留在服务组里，只是每一项都单独成行（以前是一整块自绘面板，
 * 行列都对不齐，跟这一页别的行风格割裂）。
 */
export const STREAMING: SettingsGroupDef = { id: 'streaming', titleKey: 'options.settingsHeadingStreaming' };
/**
 * 系统歌词（fork 独有，安卓）：状态栏歌词（Lyricon）与 ColorOS 原生锁屏歌词。
 *
 * 两者都是「连到系统 / 另一个 App」，所以放在连接与集成页，而不是外观页。
 * 桌面端这两项自己判运行时返回 null，整组空着不好看 —— 由页面按平台决定是否渲染。
 */
export const SYSTEM_LYRICS: SettingsGroupDef = {
    id: 'systemLyrics',
    titleKey: 'options.settingsHeadingSystemLyrics',
    // 与页面上的判断同一个：非安卓那一组一个都不画，搜索也别列一个空组。
    available: () => isCapacitorAndroid(),
};


export const O = {
    navidrome: option(SERVICES, 'navidrome', 'navidrome.enable'),
    navidromeUrl: option(SERVICES, 'navidromeServerUrl', 'navidrome.serverUrl'),
    navidromeUsername: option(SERVICES, 'navidromeUsername', 'navidrome.username'),
    navidromePassword: option(SERVICES, 'navidromePassword', 'navidrome.password'),
    sync: option(SERVICES, 'r2Sync', 'options.r2Sync'),
    syncUrl: option(SERVICES, 'r2SyncWorkerUrl', 'options.r2SyncWorkerUrl'),
    syncToken: option(SERVICES, 'r2SyncToken', 'options.r2SyncToken'),
    discord: option(SERVICES, 'discordRichPresence', 'options.discordRichPresence', { electronOnly: true }),
    scrobble: option(SERVICES, 'scrobbleSettings', 'options.neteaseScrobble'),
    transparentBackground: option(STREAMING, 'transparentPlayerBackground', 'options.transparentPlayerBackground'),
    obs: option(STREAMING, 'obsBrowserSource', 'options.obsBrowserSource', { electronOnly: true }),
    obsKeepAnimation: option(STREAMING, 'obsKeepMainWindowAnimation', 'options.obsKeepMainWindowAnimation', { electronOnly: true }),
    lyricApi: option(STREAMING, 'lyricApi', 'options.lyricApi', { electronOnly: true }),
    stage: option(STREAMING, 'stageMode', 'options.stageMode'),
    stageSource: option(STREAMING, 'stageSource', 'options.stageSource'),
    playerCapAddress: option(STREAMING, 'playerCapAddress', 'options.playerCapAddress'),
    playerCapPlayer: option(STREAMING, 'playerCapPlayer', 'options.playerCapPlayer'),
    playerCapTimeline: option(STREAMING, 'playerCapTimeline', 'options.playerCapTimeline'),
    playerCapIgnoreClear: option(STREAMING, 'playerCapIgnoreClear', 'options.playerCapIgnoreClear'),
    /*
     * 系统歌词那组的两项。
     *
     * 这两行是**自画**的（Lyricon 与锁歌词两个组件自己出 div，不用 kit 的 Row），所以不像
     * 别的项那样由 Row 顺手登记 —— 没在这儿声明，设置搜索就一条都搜不到：搜「锁歌词」
     * 什么都没有，可页面上明明有那个开关。
     *
     * `noteKey` 是行尾那个「i」里展开的完整说明；行上不再铺一行小字。
     * `available` 决定搜索列不列它（同步），得跟组件自己的显示条件对上：
     *  Lyricon —— 安卓才有；
     *  锁歌词  —— 只有探测到 ColorOS 16+ 才渲染，而探测是异步的，所以拿缓存里的结论
     *             （peekColorOsLyricsSupport）；还没探测过就先不列，比列了却点不到强。
     */
    lyricon: option(SYSTEM_LYRICS, 'lyricon', 'options.enableLyricon', {
        noteKey: 'options.lyriconDesc',
        available: isCapacitorAndroid,
    }),
    colorOsLyrics: option(SYSTEM_LYRICS, 'colorOsLyrics', 'options.colorOsLyrics', {
        noteKey: 'options.colorOsLyricsDesc',
        available: () => isCapacitorAndroid() && peekColorOsLyricsSupport()?.supported === true,
    }),
    /*
     * 洛雪音源那几项。面板本身还是 LxSourcePanel（音源列表是有状态的，做成一行控件反而不像样），
     * 但它的每一块都在这里登记一次：设置搜索要能搜到「音源」「播放路由」，行上的名字也只有一个来源。
     */    lxImport: option(SERVICES, 'lxSourceImport', 'lxmusic.importTitle', { noteKey: 'lxmusic.importNotice' }),
    lxRouteAll: option(SERVICES, 'lxRouteAllSongs', 'lxmusic.routeAllSongs', { noteKey: 'lxmusic.routeAllSongsDesc' }),
    lxPublicFallback: option(SERVICES, 'lxAllowPublicFallback', 'lxmusic.allowPublicFallback', { noteKey: 'lxmusic.allowPublicFallbackDesc' }),
    lxSources: option(SERVICES, 'lxSourceList', 'lxmusic.importedSources', { noteKey: 'lxmusic.importedSourcesDesc' }),
    lxDiagnostics: option(SERVICES, 'lxDiagnostics', 'lxmusic.diagnosticsTitle'),
};
