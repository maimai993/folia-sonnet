import { describe, expect, it } from 'vitest';
import { setTemperaTransitionBlur } from '@/components/visualizer/tempera/temperaSceneFilters';

// test/unit/visualizer/temperaSceneFilters.test.ts
// The transition blur must never sit on a scene while it is not blurring: a parked filter is
// pushed onto Pixi's filter stack as a skipped entry with `Infinity` bounds, and the lyric
// inversion below it then copies its backdrop from the wrong place. Post-process off left
// exactly that state, so this locks the attach/detach contract.
interface StubFilter { strength: number }

const createScene = (baseFilters: StubFilter[], blur: StubFilter | null) => {
    const assignments: (readonly StubFilter[] | null)[] = [];
    let filters: readonly StubFilter[] | null = baseFilters.length > 0 ? baseFilters : null;
    const scene = {
        container: {
            get filters() { return filters; },
            set filters(value: readonly StubFilter[] | null) {
                filters = value;
                assignments.push(value);
            },
        },
        baseFilters,
        transitionBlurFilter: blur,
        transitionBlurAttached: false,
    };
    return { scene: scene as unknown as Parameters<typeof setTemperaTransitionBlur>[0], assignments, current: () => filters };
};

describe('Tempera scene filters', () => {
    it('keeps the scene free of the blur until it actually blurs', () => {
        const blur = { strength: 0 };
        const { scene, assignments, current } = createScene([], blur);

        setTemperaTransitionBlur(scene, 0);

        expect(assignments).toHaveLength(0);
        expect(current()).toBeNull();
    });

    it('attaches the blur for the transition and takes it off again', () => {
        const blur = { strength: 0 };
        const { scene, assignments, current } = createScene([], blur);

        setTemperaTransitionBlur(scene, 4);
        expect(blur.strength).toBe(4);
        expect(current()).toEqual([blur]);

        // Ramping within the transition must not touch the container again: reassigning
        // filters restructures the render group.
        setTemperaTransitionBlur(scene, 6);
        expect(blur.strength).toBe(6);
        expect(assignments).toHaveLength(1);

        setTemperaTransitionBlur(scene, 0);
        // An empty array is how Pixi drops the filter effect entirely.
        expect(current()).toEqual([]);
        expect(assignments).toHaveLength(2);
    });

    it('keeps the post-process chain underneath the blur', () => {
        const post = [{ strength: 0 }, { strength: 0 }];
        const blur = { strength: 0 };
        const { scene, current } = createScene(post, blur);

        setTemperaTransitionBlur(scene, 2);
        expect(current()).toEqual([...post, blur]);

        setTemperaTransitionBlur(scene, 0);
        expect(current()).toEqual(post);
    });

    it('does nothing when the scene has no transition blur', () => {
        const { scene, assignments } = createScene([], null);

        setTemperaTransitionBlur(scene, 5);

        expect(assignments).toHaveLength(0);
    });
});
