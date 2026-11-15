import React, { useMemo } from 'react';
import '../../src/i18n/config';
import type { Theme } from '../../src/types';
import type { ArchivePlay } from '../../src/services/listeningArchive/types';
import { countsAsCompleted, countsAsPlay, splitSegments } from '../../src/services/listeningArchive/rules';
import { SettingsKitThemeContext, settingsTokens } from '../../src/components/modal/settings/kit/kitTheme';
import RankingsTab from '../../src/components/app/listeningArchive/RankingsTab';
import TimelineTab from '../../src/components/app/listeningArchive/TimelineTab';
import SongTrajectoryTab from '../../src/components/app/listeningArchive/SongTrajectoryTab';
import ArchiveSettingsTab from '../../src/components/app/listeningArchive/ArchiveSettingsTab';
import type { ProbeDefinition } from './definition';
// dev/probes/listeningArchive.probe.tsx

/**
 * 听歌档案的四个分页：排行、时长、单曲轨迹、设置。
 *
 * 档案自己从 Dexie 读记录，探针里没有那份数据，所以这里直接造一批播放记录喂给各分页的
 * plays prop（分页就是收这个 prop 的）。造出来的记录走真的 splitSegments / countsAsPlay /
 * countsAsCompleted，跨午夜的那几条会真的被切成两段，图表那一侧的累计也就跟着是真的。
 *
 * 数字只喂一套固定种子，同一个探针跑两次画出来一样，方便对比改动前后。
 */

const THEME = { primaryColor: '#8b5cf6' } as Theme;
const COVER_COLORS = ['#6d5a8c', '#3f6f7a', '#a8664b', '#56745a', '#8a4f5d', '#4d5f8f'];

const coverFor = (index: number): string => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">'
    + '<rect width="120" height="120" fill="' + COVER_COLORS[index % COVER_COLORS.length] + '"/></svg>',
);

const SONGS = [
    { title: '夜航西飞', artists: ['林间乐队'], album: '夜航' },
    { title: 'Harbour Lights', artists: ['Ivo Marsh'], album: 'Harbour' },
    { title: '七月的河流', artists: ['苏晚'], album: '七月' },
    { title: 'Slow Tides', artists: ['Ivo Marsh'], album: 'Harbour' },
    { title: '走廊尽头', artists: ['林间乐队', '苏晚'], album: '夜航' },
    { title: 'Paper Kites', artists: ['Nell Ålund'], album: 'Paper' },
    { title: '山雾', artists: ['苏晚'], album: '七月' },
    { title: 'Half Awake', artists: ['Nell Ålund'], album: 'Paper' },
];

/** 固定种子的伪随机：同一个探针每次画出来一样。 */
const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
};

const buildPlays = (): ArchivePlay[] => {
    const random = seeded(20240101);
    const now = Date.now();
    const plays: ArchivePlay[] = [];
    for (let index = 0; index < 260; index += 1) {
        // 越靠前的歌听得越多：排行因此有层次，而不是每首一样。
        const songIndex = Math.min(SONGS.length - 1, Math.floor(random() ** 2 * SONGS.length));
        const song = SONGS[songIndex];
        const daysAgo = Math.floor(random() * 380);
        const startedAt = now - daysAgo * 24 * 60 * 60 * 1000 - Math.floor(random() * 20) * 60 * 60 * 1000;
        const totalSeconds = 180 + Math.floor(random() * 160);
        const listenedSeconds = Math.max(5, Math.floor(totalSeconds * (0.15 + random() * 0.95)));
        const endedAt = startedAt + listenedSeconds * 1000;
        plays.push({
            id: 'probe-' + index,
            songKey: 'probe-song-' + songIndex,
            songId: 'probe-song-' + songIndex,
            providerId: 'local',
            title: song.title,
            artists: song.artists,
            albumName: song.album,
            coverUrl: songIndex % 4 === 3 ? '' : coverFor(songIndex),
            startedAt,
            endedAt,
            listenedSeconds,
            totalSeconds,
            counted: countsAsPlay(listenedSeconds, totalSeconds),
            completed: countsAsCompleted(listenedSeconds, totalSeconds),
            segments: splitSegments(startedAt, endedAt, totalSeconds),
        });
    }
    return plays.sort((first, second) => second.startedAt - first.startedAt);
};

const Section: React.FC<{ title: string; height: string; children: React.ReactNode }> = ({ title, height, children }) => (
    <section className="mb-6">
        <h2 className="mb-2 text-xs uppercase tracking-widest text-zinc-500">{title}</h2>
        <div className={height}>{children}</div>
    </section>
);

const ListeningArchiveProbe: React.FC = () => {
    const plays = useMemo(buildPlays, []);
    const reload = React.useCallback(() => undefined, []);
    return (
        <SettingsKitThemeContext.Provider value={{ isDaylight: false, theme: THEME }}>
            <div
                className="min-h-screen bg-zinc-900 p-6 font-sans text-[color:var(--st-t1)]"
                style={settingsTokens(false, THEME)}
            >
                <Section title="Rankings" height="h-[520px]">
                    <RankingsTab plays={plays} />
                </Section>
                <Section title="Timeline" height="h-[640px]">
                    <TimelineTab plays={plays} isDaylight={false} />
                </Section>
                <Section title="Song trajectory" height="h-[720px]">
                    <SongTrajectoryTab plays={plays} />
                </Section>
                <Section title="Settings" height="h-[420px]">
                    <ArchiveSettingsTab playCount={plays.length} isDaylight={false} onReload={reload} />
                </Section>
            </div>
        </SettingsKitThemeContext.Provider>
    );
};

const probe: ProbeDefinition = {
    id: 'listeningArchive',
    title: '听歌档案四个分页',
    description: '排行 / 时长 / 单曲轨迹 / 设置，喂一份固定种子造出来的播放记录，看真实布局与图表。',
    Component: ListeningArchiveProbe,
};

export default probe;
