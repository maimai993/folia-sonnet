import { describe, expect, it, vi } from 'vitest';
import {
    destroySonnetContainerChildren,
    unloadSonnetDisplayTree,
} from '@/components/visualizer/sonnet/sonnetPixiResources';
import { setPixiDisplayTreeVisibility } from '@/components/visualizer/pixiDisplayResources';

describe('Sonnet Pixi resource lifecycle', () => {
    it('unloads every renderable in a retained shot tree', () => {
        const leafUnload = vi.fn();
        const branchUnload = vi.fn();
        const root = {
            children: [{ unload: branchUnload, children: [{ unload: leafUnload }] }],
        };

        unloadSonnetDisplayTree(root);

        expect(branchUnload).toHaveBeenCalledOnce();
        expect(leafUnload).toHaveBeenCalledOnce();
    });

    it('destroys detached overlay children instead of merely removing them', () => {
        const unload = vi.fn();
        const destroy = vi.fn();
        const removeChildren = vi.fn(() => [{ unload, destroy }]);

        destroySonnetContainerChildren({ removeChildren });

        expect(unload).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledWith({ children: true });
    });

    it('unloads retained descendants only when their tree becomes hidden', () => {
        const unload = vi.fn();
        const root = { visible: true, children: [{ unload }] };

        setPixiDisplayTreeVisibility(root, true);
        expect(unload).not.toHaveBeenCalled();

        setPixiDisplayTreeVisibility(root, false);
        expect(unload).toHaveBeenCalledOnce();

        setPixiDisplayTreeVisibility(root, false);
        expect(unload).toHaveBeenCalledOnce();

        setPixiDisplayTreeVisibility(root, true);
        expect(root.visible).toBe(true);
        expect(unload).toHaveBeenCalledOnce();
    });
});
