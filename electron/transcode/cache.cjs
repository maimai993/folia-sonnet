'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Owns deterministic cache paths and atomic publication for complete transcode representations.

const CACHE_VERSION = 'audio-v1-48k-stereo';

const getTranscodeCacheDirectory = userDataDirectory => path.join(userDataDirectory, 'transcode-cache');

const buildTranscodeCacheKey = source => crypto
    .createHash('sha256')
    .update(JSON.stringify({
        version: CACHE_VERSION,
        kind: source.kind,
        songKey: source.songKey,
        sourceRevision: source.sourceRevision,
    }))
    .digest('hex');

const getCacheEntryPaths = (cacheDirectory, cacheKey, format) => {
    const directory = path.join(cacheDirectory, cacheKey);
    return {
        directory,
        audioPath: path.join(directory, `audio.${format}`),
        metadataPath: path.join(directory, 'metadata.json'),
    };
};

const readValidCacheEntry = async (cacheDirectory, cacheKey) => {
    for (const format of ['flac', 'wav']) {
        const paths = getCacheEntryPaths(cacheDirectory, cacheKey, format);
        try {
            const [metadataText, stat] = await Promise.all([
                fs.promises.readFile(paths.metadataPath, 'utf8'),
                fs.promises.stat(paths.audioPath),
            ]);
            const metadata = JSON.parse(metadataText);
            if (metadata.cacheVersion === CACHE_VERSION && metadata.format === format && stat.isFile() && stat.size >= 128) {
                return { ...paths, format, mimeType: format === 'flac' ? 'audio/flac' : 'audio/wav' };
            }
        } catch {
            // Incomplete or obsolete cache entries are misses and will be atomically replaced.
        }
    }
    return null;
};

const publishCacheEntry = async ({ cacheDirectory, cacheKey, format, temporaryAudioPath, metadata }) => {
    const paths = getCacheEntryPaths(cacheDirectory, cacheKey, format);
    await fs.promises.mkdir(paths.directory, { recursive: true });
    const stagingAudio = `${paths.audioPath}.publishing`;
    const stagingMetadata = `${paths.metadataPath}.publishing`;
    await fs.promises.copyFile(temporaryAudioPath, stagingAudio);
    await fs.promises.writeFile(stagingMetadata, JSON.stringify({
        ...metadata,
        cacheVersion: CACHE_VERSION,
        format,
    }, null, 2));
    await Promise.all([
        fs.promises.rm(paths.audioPath, { force: true }),
        fs.promises.rm(paths.metadataPath, { force: true }),
    ]);
    await fs.promises.rename(stagingAudio, paths.audioPath);
    await fs.promises.rename(stagingMetadata, paths.metadataPath);
    return { ...paths, format, mimeType: format === 'flac' ? 'audio/flac' : 'audio/wav' };
};

module.exports = {
    CACHE_VERSION,
    buildTranscodeCacheKey,
    getCacheEntryPaths,
    getTranscodeCacheDirectory,
    publishCacheEntry,
    readValidCacheEntry,
};
