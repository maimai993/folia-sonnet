// src/components/visualizer/kinetic/kineticProjectMemory.ts
// 按歌曲记住文字PV 的编辑结果。
//
// 原版编辑台的工程原本只活在 iframe 里：换歌、重启应用就回到默认样式，
// 用户辛苦调好的布局与配色全丢。这里按歌曲键把工程存下来，下次播这首歌自动还原。
//
// 存法沿用项目里 lyricOffsetMemory 的约定：单个 localStorage 键，里层是 songKey -> 工程 的 map，
// 外加一个数量上限，免得歌多了一直涨。

import type { KineticProjectSnapshot } from './kineticProjectTypes';

const STORAGE_KEY = 'kinetic_projects';
/** 最多记住多少首歌的编辑结果，超了淘汰最早写入的。 */
const MAX_ENTRIES = 60;

type StoredEntry = {
    /** 写入时间：淘汰时按它挑最旧的。 */
    at: number;
    project: KineticProjectSnapshot;
};

type StoredMap = Record<string, StoredEntry>;

const readMap = (): StoredMap => {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as StoredMap : {};
    } catch (error) {
        console.warn('[Kinetic] 读取已存的文字PV 工程失败', error);
        return {};
    }
};

const writeMap = (map: StoredMap) => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (error) {
        // 配额满了：丢掉一半再试一次，不要因为存不下就把功能弄崩。
        console.warn('[Kinetic] 保存文字PV 工程失败，尝试裁剪后重写', error);
        const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, Math.floor(MAX_ENTRIES / 2));
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch (retryError) {
            console.warn('[Kinetic] 裁剪后仍写不进去，放弃本次保存', retryError);
        }
    }
};

/** 这首歌上次编辑过的工程；没有就返回 null（用默认样式）。 */
export const readKineticProject = (songKey: string | null | undefined): KineticProjectSnapshot | null => {
    if (!songKey) return null;
    const entry = readMap()[String(songKey)];
    return entry && entry.project ? entry.project : null;
};

/** 记住这首歌的工程。传 null 表示清掉（回到默认样式）。 */
export const writeKineticProject = (songKey: string | null | undefined, project: KineticProjectSnapshot | null) => {
    if (!songKey) return;
    const map = readMap();
    if (project === null) {
        delete map[String(songKey)];
        writeMap(map);
        return;
    }
    map[String(songKey)] = { at: Date.now(), project };
    // 超上限就按写入时间淘汰最旧的。
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => map[b].at - map[a].at)
            .slice(MAX_ENTRIES)
            .forEach((key) => { delete map[key]; });
    }
    writeMap(map);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('kinetic:project-saved'));
};

/** 清掉所有歌曲的编辑记录（设置里的「重置」用）。 */
export const clearAllKineticProjects = () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
};
