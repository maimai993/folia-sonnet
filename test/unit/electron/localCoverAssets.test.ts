import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

// test/unit/electron/localCoverAssets.test.ts
// Locks local-library cover binaries to Electron userData instead of the configurable media cache directory.

const require = createRequire(import.meta.url);
const { getLocalCoverAssetDirectory } = require('../../../electron/localCoverAssets.cjs') as {
    getLocalCoverAssetDirectory: (userDataDirectory: string) => string;
};

describe('localCoverAssets', () => {
    it('places local-library covers directly under userData', () => {
        const userDataDirectory = path.join('C:', 'Users', 'tester', 'Folia');

        expect(getLocalCoverAssetDirectory(userDataDirectory)).toBe(
            path.join(userDataDirectory, 'local-cover-assets'),
        );
    });
});
