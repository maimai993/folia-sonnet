import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/settings/settingsAnchorCoverage.test.ts
// The sidebar table of contents only lists sections wrapped in <SettingsAnchor>. Two of these live
// in files rendered by a different subview (PinnedCommandSettings, TransitionSettingsSection), so a
// plain <section> slipping back in is easy to miss by eye and invisible until the entry disappears.

const SETTINGS_DIR = path.join(process.cwd(), 'src/components/modal/settings');

const settingsFiles = fs.readdirSync(SETTINGS_DIR)
    .filter(name => name.endsWith('.tsx'))
    .map(name => path.join(SETTINGS_DIR, name));

describe('settings section anchors', () => {
    it.each(settingsFiles.map(file => [path.basename(file), file]))('uses SettingsAnchor instead of a bare section in %s', (_name, file) => {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/<section[\s>]/);
    });

    it('registers a unique anchor id per rendered section', () => {
        const ids = settingsFiles.flatMap(file => (
            [...fs.readFileSync(file, 'utf8').matchAll(/<SettingsAnchor anchorId="([^"]+)"/g)].map(match => match[1])
        ));

        expect(ids.length).toBeGreaterThan(20);

        // stageMode is declared twice on purpose: the Electron and web panels are mutually exclusive.
        const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
        expect(duplicates).toEqual(['stageMode']);
    });
});
