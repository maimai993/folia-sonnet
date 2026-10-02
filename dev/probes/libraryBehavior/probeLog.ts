// dev/probes/libraryBehavior/probeLog.ts
// 行为探针的两本账：上游请求（假 provider、Navidrome 垫片）和宿主收到的回调（播放、入队、刷新）。
// 用例只读这两本账做语义断言，所以 renderer 换成别的形态时同一批断言仍然成立。

export type ProbeRequest = {
    seq: number;
    provider: string;
    op: string;
    target?: string;
    offset?: number;
    limit?: number;
    ids?: string[];
    outcome: 'ok' | 'error';
};

export type ProbeCallKind =
    | 'playSong'
    | 'playAll'
    | 'addAllToQueue'
    | 'addSongToQueue'
    | 'addLocalSongToQueue'
    | 'addNavidromeSongsToQueue'
    | 'refreshUser'
    | 'refreshLocalSongs'
    | 'statusMessage';

export type ProbeCall = {
    seq: number;
    kind: ProbeCallKind;
    /** 播放/入队涉及的歌曲（playback key 或本地/Navidrome 原始 id）。 */
    ids: string[];
    /** playSong 的上下文队列。 */
    queueIds?: string[];
    text?: string;
};

type ProbeLogState = {
    requests: ProbeRequest[];
    calls: ProbeCall[];
    version: number;
};

let state: ProbeLogState = { requests: [], calls: [], version: 0 };
let seq = 0;
const listeners = new Set<() => void>();

const publish = (next: Partial<ProbeLogState>) => {
    state = { ...state, ...next, version: state.version + 1 };
    listeners.forEach(listener => listener());
};

export const recordProbeRequest = (request: Omit<ProbeRequest, 'seq'>): void => {
    seq += 1;
    publish({ requests: [...state.requests, { ...request, seq }] });
};

export const recordProbeCall = (call: Omit<ProbeCall, 'seq'>): void => {
    seq += 1;
    publish({ calls: [...state.calls, { ...call, seq }] });
};

export const clearProbeRequests = (): void => publish({ requests: [] });
export const clearProbeCalls = (): void => publish({ calls: [] });
export const getProbeLog = (): ProbeLogState => state;

export const subscribeProbeLog = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
