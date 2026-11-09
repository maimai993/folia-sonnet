// src/components/modal/settings/pages/integration/market.ts
//
// 「市场」这一组的定义。
//
// 单独一个文件而不是塞进 options.ts：那边已经有乱码的历史包袱，
// 而且市场组的选项和连接类选项没什么共同点。

import { option, type SettingsGroupDef } from '../../kit';

/**
 * 背景与文字市场。
 *
 * 分两个区块：背景（视频 / 图片，可应用到桌面壁纸或 App 内歌词可视化）
 * 和字体（可应用到歌词、字幕或系统壁纸歌词）。两种都有「用在哪」的选择，
 * 应用范围可以在这个页面随时改。
 */
export const MARKET: SettingsGroupDef = {
    id: 'market',
    titleKey: 'options.settingsHeadingMarket',
};

export const M = {
    background: option(MARKET, 'backgroundMarket', 'options.backgroundMarket'),
    font: option(MARKET, 'fontMarket', 'options.fontMarket'),
};
