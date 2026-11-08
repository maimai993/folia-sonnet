import React from 'react';
import { useRowAria } from './Row';
import { sliderValueOnTrack, useSliderGesture } from './sliderGesture';

// src/components/modal/settings/kit/Slider.tsx
// A slider with its value beside it. The filled part of the track is a gradient cut at --st-p, which
// the input sets from its value. The value is brought onto the track once (inside min and max, on a
// step), and the thumb, the fill, the text beside the track and what a screen reader hears all use
// that one number.
//
// Marks are the values people come back to: small ticks under the track, with a short name under a
// tick where one is given. A drag, or a press on the track, that ends within a few pixels of a mark
// lands on it; the arrow keys still move by the step, and every value between the marks stays
// possible. A press on a mark's name goes to that mark. Names need room: those of marks closer
// together than the names are wide run into each other.
//
// Stacked, for a narrow column: alone in its Row, the value ends the label's line and the track
// spans the row under it (kit.css lets the two parts lie in the row itself).
//
// Which way a press means to go is asked of sliderGesture: a finger that lands on the track and
// then travels up or down the page is a scroll, and the value stays where it was.

const RANGE_CLASS = [
    'st-slider block h-5 min-w-0 max-w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed',
    '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full',
    '[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--st-accent)_var(--st-p),var(--st-track)_var(--st-p))]',
    /*
     * 圆点用强调色，不用纯白。纯白圆点在深色主题下是一块和界面对不上的异物 ——
     * 和 components/ui/Slider 保持同一套配色，两处滑杆看起来才是同一种控件。
     */
    '[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none',
    '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--st-accent)]',
    '[&::-webkit-slider-thumb]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--st-on-accent)_45%,transparent),0_1px_4px_rgba(0,0,0,0.28)]',
    '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--st-track)]',
    '[&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[var(--st-accent)]',
    '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--st-accent)]',
].join(' ');

type SliderProps = {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
    /** How the value reads beside the track, e.g. `v => `${v}%``. */
    format: (value: number) => string;
    /** Values the track marks with a tick; one the slider cannot take is moved to the nearest it can. `label` is a short name under the tick. */
    marks?: ReadonlyArray<{ value: number; label?: string }>;
    /** For a narrow column, alone in its Row: the value ends the label's line, the track spans the row. */
    stacked?: boolean;
    disabled?: boolean;
};

export const Slider: React.FC<SliderProps> = ({ value, min, max, step = 1, onChange, format, marks, stacked, disabled }) => {
    const aria = useRowAria();
    const { inputRef, handlers } = useSliderGesture({
        min,
        max,
        step,
        onChange,
        disabled,
        marks: marks?.map(mark => mark.value),
    });
    const shown = sliderValueOnTrack(value, min, max, step);
    const filled = max > min ? ((shown - min) / (max - min)) * 100 : 0;
    // Each mark where the track can show it: what the thumb lands on and what a press on its name sets.
    const stops = marks?.map(mark => ({ value: sliderValueOnTrack(mark.value, min, max, step), label: mark.label }));
    const named = stops?.some(mark => mark.label !== undefined) ?? false;
    const dim = disabled ? ' opacity-40' : '';
    const text = format(shown);

    const track = (
        <>
            {stops && max > min && (
                // As wide as the thumb's travel, and under the input (which is `relative` for this): the
                // thumb covers the tick it stands on.
                <span aria-hidden className="pointer-events-none absolute inset-x-2 top-0">
                    {stops.map((mark) => {
                        const left = `${((mark.value - min) / (max - min)) * 100}%`;
                        return (
                            <React.Fragment key={mark.value}>
                                <span className="absolute top-3.5 h-1 w-px -translate-x-1/2 bg-[var(--st-t3)]" style={{ left }} />
                                {mark.label !== undefined && (
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        disabled={disabled}
                                        // The name takes no focus (it is hidden from assistive tech): the
                                        // slider gets it, so the arrow keys go on from the mark.
                                        onMouseDown={event => event.preventDefault()}
                                        onClick={() => {
                                            inputRef.current?.focus();
                                            if (shown !== mark.value) onChange(mark.value);
                                        }}
                                        className={`st-t-fast pointer-events-auto absolute top-[22px] -translate-x-1/2 whitespace-nowrap text-[11px] leading-[14px] transition-colors enabled:hover:text-[color:var(--st-t1)] ${shown === mark.value ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t3)]'}`}
                                        style={{ left }}
                                    >
                                        {mark.label}
                                    </button>
                                )}
                            </React.Fragment>
                        );
                    })}
                </span>
            )}
            <input
                ref={inputRef}
                type="range"
                {...aria}
                {...handlers}
                aria-valuetext={text}
                min={min}
                max={max}
                step={step}
                value={shown}
                disabled={disabled}
                className={`${RANGE_CLASS} ${stacked ? 'w-full' : 'w-[200px]'}${stops ? ' relative' : ''}`}
                style={{ '--st-p': `${filled}%` } as React.CSSProperties}
            />
        </>
    );

    if (stacked) {
        return (
            <span className="st-slider-stacked">
                <output className={`ml-auto shrink-0 text-[13px] text-[color:var(--st-t2)] tabular-nums${dim}`}>{text}</output>
                <span className={`relative mb-1 mt-1.5 min-w-0 basis-full${named ? ' pb-4' : ''}${dim}`}>{track}</span>
            </span>
        );
    }

    return (
        <span className={`flex min-w-0 gap-3 ${named ? 'items-start' : 'items-center'}${dim}`}>
            <span className={`relative min-w-0${named ? ' pb-4' : ''}`}>{track}</span>
            <output className={`w-[52px] shrink-0 text-right text-[13px] text-[color:var(--st-t1)] tabular-nums${named ? ' leading-5' : ''}`}>
                {text}
            </output>
        </span>
    );
};

// Kept here: the pages and the tests read it from the slider's own file.
export { landOnMark } from './sliderGesture';

export default Slider;
