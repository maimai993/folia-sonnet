// src/components/modal/settings/pages/integration/market/MarketFilterSlot.tsx
//
// 让「筛选条件」能从区块里渲染到区块外。
//
// 为什么需要这个：
//   横屏时布局是「左边筛选、右边卡片」。但筛选的状态（分类 / 来源 / 关键词）
//   本来就活在各自区块内部（MarketFontSection / MarketBackgroundSection），
//   而且和取数 hook 绑在一起 —— 把状态整个提到外面，等于把两个区块拆开重写。
//
//   所以反过来：区块同时提供一个「只有筛选」的副本（filtersOnly），
//   左栏渲染副本、右栏渲染主内容并隐藏筛选。
//   两边的状态是不同的实例，所以用一个极小的共享 store 让它们同步。

import { create } from 'zustand';
import type { BackgroundMarketSourceId } from '../../../../../../services/backgroundMarket';

export interface MarketFilterState {
    /** 字体：分类 slug */
    fontCategory: string;
    fontKeyword: string;
    /** 背景：来源、分类、关键词 */
    backgroundSource: BackgroundMarketSourceId;
    backgroundCategory: string;
    backgroundKeyword: string;
    set: (patch: Partial<Omit<MarketFilterState, 'set'>>) => void;
}

/**
 * 筛选条件放这里而不是各区块内部。
 *
 * 横屏要「左边筛选、右边卡片」，两栏是两个组件实例，
 * 状态若留在各自内部就会各走各的 —— 左边点了分类右边不更新。
 */
export const useMarketFilterStore = create<MarketFilterState>((set) => ({
    fontCategory: 'zh',
    fontKeyword: '',
    backgroundSource: 'moewalls',
    backgroundCategory: '',
    backgroundKeyword: '',
    set: (patch) => set(patch),
}));
