import React, { useId } from 'react';
import { motion } from 'framer-motion';
import { useReducedMotionFor } from '../../hooks/useReducedMotionFor';

// src/components/folia-grid/GridViewTabs.tsx
// The second level of the home header's view capsule: centred right under it, a smaller capsule
// holding the map of all cards and, where the grid has them, its collection types (folders /
// albums / artists / playlists). Every type stays on screen so the switch reads as a switch: the
// active one shows its label, the rest shrink to their icon. It used to collapse to the active
// type behind a small chevron, styled like the action buttons, and listeners never found the rest.

/**
 * The look of the controls row under the home header. Pill and text colours come from the header's
 * own tab switcher (Grid3D: navPillBg, navPillInactiveText) so the row reads as part of the same
 * chrome. The active option deliberately does not reuse the header's white pill: that marks the
 * page, and a second one of equal weight right below it made the two levels impossible to tell
 * apart.
 */
export const gridChromeClassesFor = (isDaylight: boolean) => ({
    pill: isDaylight ? 'bg-black/5' : 'bg-white/10',
    softText: isDaylight ? 'text-black/60 hover:text-black' : 'text-white/60 hover:text-white',
    strongText: isDaylight ? 'text-black/85' : 'text-white/90',
    activePill: isDaylight ? 'bg-black/10' : 'bg-white/15',
    divider: isDaylight ? 'bg-black/10' : 'bg-white/15',
});

export type GridViewTab = {
    id: string;
    label: React.ReactNode;
    /** Without an icon an option keeps its label even when inactive, or it would be blank. */
    icon?: React.ReactNode;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
};

type GridViewTabsProps = {
    tabs: GridViewTab[];
    isDaylight: boolean;
    /** The map-of-all-cards entry, first in the capsule and set off from the types by a rule. */
    onOpenMap?: () => void;
    mapLabel?: string;
    mapIcon?: React.ReactNode;
    /** Marks the capsule for the Ponder hover lookup. */
    ponderId?: string;
};

const SPRING = { type: 'spring', stiffness: 460, damping: 36, mass: 0.9 } as const;

export const GridViewTabs: React.FC<GridViewTabsProps> = ({ tabs, isDaylight, onOpenMap, mapLabel, mapIcon, ponderId }) => {
    // Scoped per instance so two grids never share one sliding highlight.
    const highlightId = useId();
    const calm = useReducedMotionFor('uiMicroMotion');
    const transition = calm ? { duration: 0 } : SPRING;
    const chrome = gridChromeClassesFor(isDaylight);

    return (
        <div className={`pointer-events-auto flex h-7 items-center rounded-full p-0.5 backdrop-blur-md ${chrome.pill}`}>
            {onOpenMap && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.currentTarget.blur();
                        onOpenMap();
                    }}
                    className={`flex h-6 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${chrome.softText}`}
                >
                    {mapIcon}
                    <span className="whitespace-nowrap">{mapLabel}</span>
                </button>
            )}
            {onOpenMap && tabs.length > 0 && <span aria-hidden="true" className={`mx-1 h-3.5 w-px ${chrome.divider}`} />}
            {tabs.length > 0 && (
                <div role="tablist" data-ponder={ponderId} className="flex items-center">
                    {tabs.map(tab => {
                        const label = typeof tab.label === 'string' ? tab.label : undefined;
                        const showLabel = tab.active || !tab.icon;
                        return (
                            <motion.button
                                key={tab.id}
                                layout
                                transition={transition}
                                type="button"
                                role="tab"
                                aria-selected={Boolean(tab.active)}
                                aria-label={label}
                                // The icon-only options need their name somewhere a pointer can reach.
                                title={showLabel ? undefined : label}
                                disabled={tab.disabled}
                                onClick={() => {
                                    if (!tab.active) tab.onClick();
                                }}
                                className={`relative flex h-6 items-center gap-1.5 rounded-full text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                                    showLabel ? 'px-3' : 'w-7 justify-center'
                                } ${tab.active ? chrome.strongText : chrome.softText}`}
                            >
                                {tab.active && (
                                    <motion.span
                                        layoutId={highlightId}
                                        transition={transition}
                                        className={`absolute inset-0 rounded-full ${chrome.activePill}`}
                                    />
                                )}
                                {tab.icon && <span className="relative flex shrink-0 items-center">{tab.icon}</span>}
                                {showLabel && (
                                    <motion.span
                                        initial={calm || !tab.active ? false : { opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: calm ? 0 : 0.18, delay: calm ? 0 : 0.06 }}
                                        className="relative whitespace-nowrap"
                                    >
                                        {tab.label}
                                    </motion.span>
                                )}
                            </motion.button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default GridViewTabs;
