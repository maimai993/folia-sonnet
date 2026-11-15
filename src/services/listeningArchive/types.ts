// src/services/listeningArchive/types.ts
// 听歌档案的数据契约。
//
// 为什么是这份形状：档案要回答三个问题 —— 「我听了多久」（按时间聚合）、
// 「我最常听什么」（按歌曲 / 歌手 / 专辑聚合）、「这一首我听成什么样」（单曲轨迹）。
// 三个问题都只需要「一次播放」的完整事实，聚合全部在读取时算，所以落库只有一种行，
// 没有预聚合表：曲库变了、口径改了，重算一次就对得上，不用回填历史。
//
// 一次播放 = 一首歌从头到切歌（或暂停很久）之间的一段。它可能跨午夜，所以时长按
// 本地日拆成 `segments`；「够不够算一次」「够不够算听完整首」当场判好写在行上，
// 免得日后口径一改就再也解释不清历史数据。

/** 一次播放落库的一行。 */
export interface ArchivePlay {
    /** 记录 id：导入合并时按它去重，重复导入不增加次数。 */
    id: string;
    /** 归一后的歌曲键（规范化歌名 + 歌手集合），排行与单曲轨迹的分组依据。 */
    songKey: string;
    /** 来源里的歌曲 id，用来回放与取封面。 */
    songId: string;
    /** 来源标识（本地曲库 / 在线平台 / Navidrome 等），用于区分同一首歌的不同来源。 */
    providerId: string;
    /** 歌名，保留原始写法（归一后的在 songKey 里）。 */
    title: string;
    /** 歌手名列表，合唱歌手各占一项。 */
    artists: string[];
    /** 专辑名；取不到为 null。 */
    albumName: string | null;
    /** 封面地址；取不到为 null（界面显示占位，不留空洞）。 */
    coverUrl: string | null;
    /** 开始播放的本地时间（毫秒）。 */
    startedAt: number;
    /** 结束（切歌 / 暂停 / 退出）的本地时间（毫秒）。 */
    endedAt: number;
    /** 实测听了几秒：只累加正向步进，拖动、暂停、回退不计。 */
    listenedSeconds: number;
    /** 曲目总时长（秒）；未知为 0。 */
    totalSeconds: number;
    /** 按口径够不够算「听了一次」。 */
    counted: boolean;
    /** 按口径够不够算「听完整首」。 */
    completed: boolean;
    /** 跨午夜拆分：按设备本地日切段，秒数之和等于 listenedSeconds（允许末位误差）。 */
    segments: ArchiveSegment[];
}

/** 一次播放落在某一天的那一段。 */
export interface ArchiveSegment {
    /** `YYYY-MM-DD`，设备本地日。 */
    day: string;
    /** 这一段听了几秒。 */
    seconds: number;
    /** 这一段的起算时刻（毫秒），用于「按日期看时间轴」。 */
    startedAt: number;
}

/** 档案设置。 */
export interface ArchiveSettings {
    /** 采集开关：关掉就不再记录新的播放（已有记录保留）。 */
    enabled: boolean;
    /** 低性能模式：关掉图表动画与逐帧重绘，换来旧机器上的流畅。 */
    lowPerformance: boolean;
}

/** 聚合粒度。周日历一律以周一为起点。 */
export type ArchiveGranularity = 'day' | 'week' | 'month' | 'year';

/** 排行视角。 */
export type ArchiveRankKind = 'song' | 'artist' | 'album';

/** 排行排序口径。 */
export type ArchiveRankSort = 'plays' | 'seconds' | 'newest';

/** 排行里的一行。 */
export interface ArchiveRankEntry {
    /** 分组键：歌曲是 songKey，歌手是归一后的歌手名，专辑是归一后的专辑名。 */
    key: string;
    /** 主标题：歌名 / 歌手名 / 专辑名。 */
    title: string;
    /** 副标题：歌曲是歌手，专辑是歌手，歌手视角为空串。 */
    subtitle: string;
    /** 取一张代表封面。 */
    coverUrl: string | null;
    /** 计次（只算 counted 的播放）。 */
    plays: number;
    /** 累计秒数。 */
    seconds: number;
    /** 第一次听到它的时刻（毫秒），「新遇见」排序与标记用。 */
    firstHeardAt: number;
}

/** 时间轴上的一个桶（一天 / 一周 / 一月 / 一年）。 */
export interface ArchiveBucket {
    /** 桶键：`YYYY-MM-DD` / `YYYY-Www` / `YYYY-MM` / `YYYY`。 */
    key: string;
    /** 桶的起点（本地时间毫秒）。 */
    start: number;
    /** 桶里累计听了几秒。 */
    seconds: number;
    /** 桶里计了几次。 */
    plays: number;
}

/** 热力图的一个格子：某个星期几的某个小时听了多久。 */
export interface ArchiveHeatCell {
    /** 0 = 周一 … 6 = 周日。 */
    weekday: number;
    /** 0–23，设备本地小时。 */
    hour: number;
    seconds: number;
}

/** 单曲轨迹。 */
export interface ArchiveSongTrajectory {
    songKey: string;
    title: string;
    artists: string[];
    albumName: string | null;
    coverUrl: string | null;
    /** 累计计次。 */
    plays: number;
    /** 累计秒数。 */
    seconds: number;
    /** 第一次听到的时刻。 */
    firstHeardAt: number;
    /** 最近一次听到的时刻。 */
    lastHeardAt: number;
    /** 最近 24 个月的名次，`rank` 为 null 表示那个月没听。 */
    monthly: ArchiveMonthlyRank[];
    /** 星期分布（周一在前）。 */
    weekdaySeconds: number[];
    /** 小时分布（0–23）。 */
    hourlySeconds: number[];
    /** 按日期的时间轴（只含有记录的日子，升序）。 */
    days: ArchiveDayEntry[];
}

/** 单曲在某个月的排名。 */
export interface ArchiveMonthlyRank {
    /** `YYYY-MM`。 */
    month: string;
    rank: number | null;
    plays: number;
    seconds: number;
}

/** 某一天听这一首的情况。 */
export interface ArchiveDayEntry {
    /** `YYYY-MM-DD`。 */
    day: string;
    plays: number;
    seconds: number;
}

/** 导出的备份文件形状。 */
export interface ArchiveBackupFile {
    /** 固定标识，导入时认这个。 */
    format: 'folia-listening-archive';
    /** 备份格式版本，升版时决定怎么读。 */
    version: 1;
    /** 导出时刻（毫秒）。 */
    exportedAt: number;
    /** 原始记录。 */
    plays: ArchivePlay[];
}

/** 导入结果。 */
export interface ArchiveImportResult {
    /** 真正新增的记录数。 */
    added: number;
    /** 因为 id 重复而跳过的记录数。 */
    skipped: number;
}
