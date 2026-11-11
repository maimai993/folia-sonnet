import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #264: a background position cache can be one second old; display refresh must sample on the player looper.
const player = readFileSync('android/app/src/main/java/top/izuna/foliamajor/player/FoliaNativePlayer.kt', 'utf8');
const plugin = readFileSync('android/app/src/main/java/top/izuna/foliamajor/player/FoliaNativePlayerPlugin.kt', 'utf8');
const sample = player.slice(player.indexOf('fun sampleDisplayAnchor('), player.indexOf('fun getPositionMs()'));
const refresh = plugin.slice(plugin.indexOf('fun refreshDisplayAnchor()'), plugin.indexOf('fun seekFromSystem('));
const guard = readFileSync('android/app/src/main/java/top/izuna/foliamajor/player/DisplayAnchorGeneration.kt', 'utf8');
const prepare = player.slice(player.indexOf('fun prepare('), player.indexOf('fun play()'));
const seek = player.slice(player.indexOf('fun seek('), player.indexOf('fun setVolume('));
const crossfade = player.slice(player.indexOf('fun crossfadeTo('), player.indexOf('private fun rampCrossfade('));
const release = player.slice(player.indexOf('fun release()'), player.indexOf('fun hasMedia()'));

describe('native display anchor refresh source contract', () => {
    it('reads the live position on the player thread instead of the background cache', () => {
        expect(refresh).toContain('current.sampleDisplayAnchor');
        expect(refresh).not.toContain('mediaSnapshot()');
        expect(sample).toContain('runOnPlayer {');
        expect(sample).toContain('current.currentPosition');
        expect(sample).not.toContain('cachedPositionMs');
    });

    it('does not publish from a released or replaced player and respects pending pause', () => {
        expect(sample).toContain('if (released) return@ifCurrent');
        expect(sample).toContain('displayAnchorGeneration.ifCurrent(generation)');
        expect(sample).toContain('cachedPlaying && current.isPlaying');
        expect(refresh).toContain('instance !== owner || owner.player !== current');
    });

    it('uses the epoch only for sampling, never to discard queued player controls', () => {
        expect(player).not.toContain('displayAnchorGeneration.isLatest');
        expect(player).not.toContain('displayAnchorGeneration.applied');
        for (const control of [prepare, seek, crossfade]) {
            expect(control).toContain('displayAnchorGeneration.begin()');
            expect(control).toMatch(/runOnPlayer\s*\{\s*try\s*\{/);
            expect(control).toMatch(/finally\s*\{\s*displayAnchorGeneration\.finish\(\)/);
        }
        expect(prepare).toContain('current.setMediaItem(mediaItemFor(url, mediaId))');
        expect(prepare).toContain('current.prepare()');
        expect(seek).toContain('current.seekTo(clamped)');
        expect(crossfade).toContain('incoming.prepare()');
        expect(crossfade).toContain('rampCrossfade(old, incoming, durationMs)');
    });

    it('starts crossfade sampling protection only after all cached no-op checks pass', () => {
        const begin = crossfade.indexOf('displayAnchorGeneration.begin()');
        expect(begin).toBeGreaterThan(crossfade.indexOf('if (durationMs <= 0) return false'));
        expect(begin).toBeGreaterThan(crossfade.indexOf('if (!cachedPlaying || !hasMedia()) return false'));
        expect(begin).toBeLessThan(crossfade.indexOf('runOnPlayer {'));
        // The player-looper no-outgoing branch is inside try, so its return still finishes.
        expect(crossfade.indexOf('return@runOnPlayer')).toBeLessThan(crossfade.indexOf('} finally {'));
    });

    it('invalidates samples both when accepting and finishing controls, and permanently closes on release', () => {
        expect(guard).toMatch(/fun begin\(\)\s*\{\s*epoch\+\+\s*pending\+\+/);
        expect(guard).toMatch(/fun finish\(\)[\s\S]*?pending--\s*epoch\+\+/);
        expect(guard).toContain('!closed && pending == 0 && generation == epoch');
        expect(guard).toContain('closed = true');
        expect(guard).not.toMatch(/^\s*closed = false$/m);
        expect(release.indexOf('displayAnchorGeneration.close()')).toBeLessThan(release.indexOf('if (released) return'));
    });
});
