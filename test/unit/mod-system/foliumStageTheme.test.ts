// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { motionValue } from 'framer-motion';
import { describe, expect, it } from 'vitest';
import { useFoliumStageContext, type FoliumStageInputs } from '@/mods/folium/registries/stageContext';

// 同一挂载的主题更新与通知，证明模组的 getter 不被歌词身份的 memo 冻住。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Folium stage theme delivery', () => {
    it('delivers changed theme without remount and keeps all three song colors', async () => {
        const node = document.createElement('div'); document.body.append(node);
        const root = createRoot(node);
        let context: ReturnType<typeof useFoliumStageContext> | undefined;
        const Probe = ({ inputs }: { inputs: FoliumStageInputs }) => { context = useFoliumStageContext(inputs); return null; };
        const inputs: FoliumStageInputs = { lines: [], currentTime: motionValue(0), duration: 100, currentLineIndex: 0, paused: true, theme: { name: 'A', backgroundColor: '#112233', primaryColor: '#ffeedd', secondaryColor: '#99aabb', accentColor: '#35d9ba', fontStyle: 'sans', animationIntensity: 'normal' }, isDaylight: false, songTitle: 'same-song', songArtist: 'fixture', songAlbum: null, staticMode: false, seed: 'same-song', isPreview: true, coverUrl: null, display: {}, surface: { transparent: false, hostBackground: true }, settings: null };
        await act(async () => root.render(createElement(Probe, { inputs })));
        const first = context!;
        let notified = 0; const off = first.subscribe(() => { notified++; });
        await act(async () => root.render(createElement(Probe, { inputs: { ...inputs, theme: { ...inputs.theme, name: 'B', primaryColor: '#223344', secondaryColor: '#556677', accentColor: '#ff2299' } } })));
        expect(context).toBe(first);
        expect(first.getTheme()).toMatchObject({ name: 'B', primaryColor: '#223344', secondaryColor: '#556677', accentColor: '#ff2299' });
        expect(notified).toBe(1);
        off(); await act(async () => root.unmount()); node.remove();
    });
});
