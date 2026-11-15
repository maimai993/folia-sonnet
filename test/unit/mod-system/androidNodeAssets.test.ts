import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// test/unit/mod-system/androidNodeAssets.test.ts
// Keep the Android Node host self-contained so startup cannot fail on a missing npm dependency.

const assetRoot = path.resolve('android/app/src/main/assets/folia-node');

describe('Android Node host assets', () => {
    it('ships the fflate CommonJS runtime used by zipInstall', () => {
        const packagePath = path.join(assetRoot, 'node_modules/fflate/package.json');
        const entryPath = path.join(assetRoot, 'node_modules/fflate/index.cjs');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: string; version?: string; main?: string };
        expect(packageJson).toMatchObject({ name: 'fflate', version: '0.8.3', main: './index.cjs' });
        expect(fs.existsSync(entryPath)).toBe(true);
        const fflate = require(entryPath) as { unzipSync?: unknown };
        expect(typeof fflate.unzipSync).toBe('function');
    });
});
