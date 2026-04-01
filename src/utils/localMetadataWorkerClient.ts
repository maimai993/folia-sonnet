export interface EmbeddedMetadataResult {
    title?: string;
    artist?: string;
    album?: string;
    cover?: Blob;
    bitrate?: number;
    lyrics?: string;
    translationLyrics?: string;
    replayGain?: number;
    replayGainTrackGain?: number;
    replayGainTrackPeak?: number;
    replayGainAlbumGain?: number;
    replayGainAlbumPeak?: number;
    duration?: number;
}

let metadataWorker: Worker | null = null;
let workerRequestId = 0;
const workerCallbacks = new Map<string, (result: EmbeddedMetadataResult | null) => void>();

export const initMetadataWorker = (): Worker => {
    if (!metadataWorker) {
        metadataWorker = new Worker(
            new URL('../workers/metadataParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        metadataWorker.onmessage = (e) => {
            const { type, data, requestId, message } = e.data;
            const callback = workerCallbacks.get(requestId);
            if (callback) {
                workerCallbacks.delete(requestId);
                if (type === 'result') {
                    callback(data);
                } else {
                    console.warn('[MetadataWorker] parsing error:', message);
                    callback(null);
                }
            }
        };
    }

    return metadataWorker;
};

export const parseEmbeddedMetadataAsync = (
    file: File,
    includeCover = false
): Promise<EmbeddedMetadataResult | null> => {
    return new Promise((resolve) => {
        const worker = initMetadataWorker();
        const requestId = `meta_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, resolve);
        worker.postMessage({ type: 'parse-metadata', file, includeCover, requestId });
    });
};
