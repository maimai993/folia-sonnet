import { createRequire } from 'module';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';

// test/unit/electron/ffmpegRuntimeSlots.test.ts
// The mod exporters and the transcode fallback share one resolver but need different binaries:
// the bundled runtime is audio-only and cannot answer a transparent video export. These tests
// lock the two packaged directories apart, and lock the packaging destination to the one the
// transcode fallback actually looks in.

const require = createRequire(import.meta.url);
const {
    resolveFfmpeg,
    MODS_RUNTIME_DIR,
    TRANSCODE_RUNTIME_DIR,
    FFMPEG_BINARY_NAME,
} = require('../../../electron/modSystem/ffmpeg.cjs') as {
    resolveFfmpeg: (options: { appGetAppPath: () => string; packagedDirName?: string; }) => Promise<{ candidates: string[]; }>;
    MODS_RUNTIME_DIR: string;
    TRANSCODE_RUNTIME_DIR: string;
    FFMPEG_BINARY_NAME: string;
};

const RESOURCES = path.join('/tmp', 'folia-resources-fixture');
const originalResourcesPath = process.resourcesPath;
const originalOverride = process.env.FOLIA_FFMPEG_PATH;

// `resourcesPath` only exists inside Electron, so the packaged candidate has to be simulated.
const withResourcesPath = async (packagedDirName: string | undefined) => {
    Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });
    delete process.env.FOLIA_FFMPEG_PATH;
    const result = await resolveFfmpeg({ appGetAppPath: () => '/tmp/folia-app-fixture', packagedDirName });
    return result.candidates;
};

afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true });
    if (originalOverride === undefined) delete process.env.FOLIA_FFMPEG_PATH;
    else process.env.FOLIA_FFMPEG_PATH = originalOverride;
});

describe('ffmpeg runtime slots', () => {
    it('keeps the bundled audio-only runtime out of the mod exporters slot', () => {
        expect(TRANSCODE_RUNTIME_DIR).not.toBe(MODS_RUNTIME_DIR);
    });

    it('offers the mods slot to a caller that does not ask for another', async () => {
        const candidates = await withResourcesPath(undefined);
        expect(candidates).toContain(path.join(RESOURCES, MODS_RUNTIME_DIR, FFMPEG_BINARY_NAME));
        expect(candidates).not.toContain(path.join(RESOURCES, TRANSCODE_RUNTIME_DIR, FFMPEG_BINARY_NAME));
    });

    it('offers only the audio runtime to the transcode fallback', async () => {
        const candidates = await withResourcesPath(TRANSCODE_RUNTIME_DIR);
        expect(candidates).toContain(path.join(RESOURCES, TRANSCODE_RUNTIME_DIR, FFMPEG_BINARY_NAME));
        expect(candidates).not.toContain(path.join(RESOURCES, MODS_RUNTIME_DIR, FFMPEG_BINARY_NAME));
    });

    it('packages the bundled runtime into the directory the transcode fallback reads', () => {
        const destinations = packageJson.build.extraResources
            .filter(entry => typeof entry.from === 'string' && entry.from.startsWith('build/ffmpeg/'))
            .map(entry => entry.to);
        expect(destinations).toEqual([TRANSCODE_RUNTIME_DIR]);
    });
});
