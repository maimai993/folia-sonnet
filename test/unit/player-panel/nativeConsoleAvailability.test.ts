import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NativePlayerPlugin from '@/services/playbackEngine/nativePlayerPlugin';

// test/unit/player-panel/nativeConsoleAvailability.test.ts
// The console only acts on PCM the native engine renders: a blob:/data: song falls back to <audio>
// (nativePlaybackEngine.supports), so the console must say "unavailable" for that song, in the
// controls and in the command palette alike.

vi.mock('@/services/playbackEngine/nativePlayerPlugin', async importOriginal => ({
    ...await importOriginal<typeof NativePlayerPlugin>(),
    isNativePlayerAvailable: vi.fn(() => true),
}));
import { canUseNativeConsole } from '@/services/playbackEngine/nativeConsoleAvailability';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { audioConsoleCommands } from '@/components/command-palette/commands/audioConsoleCommands';

describe('native console availability follows the song the native engine can take', () => {
    afterEach(() => usePlaybackStore.setState({ audioSrc: null, playbackRoute: 'web' }));

    it.each([
        ['https://cdn.example/a.mp3', true],
        ['content://media/1', true],
        ['file:///data/a.flac', true],
        ['blob:http://localhost/1234', false],
        ['data:audio/mp3;base64,AAAA', false],
    ])('%s -> %s', (src, expected) => {
        expect(canUseNativeConsole('web', src)).toBe(expected);
    });

    it('stays available with nothing loaded yet, and never on hifi/external', () => {
        expect(canUseNativeConsole('web', null)).toBe(true);
        expect(canUseNativeConsole('hifi', 'https://x/a.mp3')).toBe(false);
        expect(canUseNativeConsole('external', 'https://x/a.mp3')).toBe(false);
    });

    it('the palette hides and refuses its commands while the current song is a blob', () => {
        const command = audioConsoleCommands.find(item => item.id === 'audio-console-gate')!;
        usePlaybackStore.setState({ audioSrc: 'https://cdn.example/a.mp3', playbackRoute: 'web' });
        expect(command.isAvailable?.()).toBe(true);
        usePlaybackStore.setState({ audioSrc: 'blob:http://localhost/1' });
        expect(command.isAvailable?.()).toBe(false);
        expect(command.execute('', {} as Parameters<typeof command.execute>[1])).toBe(false);
    });
});
