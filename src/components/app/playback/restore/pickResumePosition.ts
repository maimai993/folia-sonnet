// src/components/app/playback/restore/pickResumePosition.ts
//
// 同一首歌的两份磁盘位置（WebView 的 last_position、原生的会话快照）取哪一份：看谁是最后写的，不看秒数大小。
// 原生在后台被手动倒回、单曲回绕后，旧记录里较大的秒数不能再压过较新的较小值。

export type ResumeCandidate = { positionSec: number; durationSec: number; savedAt?: number };

const stamp = (candidate: ResumeCandidate): number => {
    const { savedAt } = candidate;
    return savedAt !== undefined && Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0;
};

/** 两边都有记录时取写入时间更晚的；时间相同或都缺失时以 Web 记录为准（它自带时间，原生旧包没有）。 */
export const pickResumePosition = (web: ResumeCandidate | null, native: ResumeCandidate | null): ResumeCandidate => {
    if (!web) return native ?? { positionSec: 0, durationSec: 0 };
    if (!native) return web;
    const chosen = stamp(native) > stamp(web) ? native : web;
    const other = chosen === native ? web : native;
    return { ...chosen, durationSec: chosen.durationSec > 0 ? chosen.durationSec : other.durationSec };
};
