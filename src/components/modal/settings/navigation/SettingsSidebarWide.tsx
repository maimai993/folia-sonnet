import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Theme } from '../../../../types';
import type { SettingsAnchor } from './settingsAnchorStore';
import type { SettingsNavGroup, SettingsSectionId } from './settingsNavModel';
// src/components/modal/settings/navigation/SettingsSidebarWide.tsx
// Wide-layout settings navigation: grouped sections with the active one expanded into a table of
// contents for its own subsections.

const EXPAND_TRANSITION = { duration: 0.24, ease: 'easeOut' as const };

type SettingsSidebarWideProps = {
    groups: SettingsNavGroup[];
    activeSectionId: SettingsSectionId;
    onSelectSection: (sectionId: SettingsSectionId) => void;
    anchors: SettingsAnchor[];
    activeAnchorId: string | null;
    onSelectAnchor: (anchorId: string) => void;
    isDaylight: boolean;
    reducedMotion: boolean;
    theme?: Theme;
};

export const SettingsSidebarWide: React.FC<SettingsSidebarWideProps> = ({
    groups,
    activeSectionId,
    onSelectSection,
    anchors,
    activeAnchorId,
    onSelectAnchor,
    isDaylight,
    reducedMotion,
    theme,
}) => {
    const accentColor = theme?.accentColor || (isDaylight ? '#44403c' : '#f4f4f5');

    const renderTableOfContents = () => (
        <div className="mt-1 flex flex-col gap-0.5 pl-[26px]">
            {anchors.map((anchor) => {
                const isActive = activeAnchorId === anchor.id;
                return (
                    <button
                        key={anchor.id}
                        type="button"
                        title={anchor.label}
                        onClick={() => onSelectAnchor(anchor.id)}
                        className={`relative rounded-lg py-1.5 pl-3 pr-2 text-left text-xs transition-colors ${isActive ? (isDaylight ? 'bg-black/[0.04]' : 'bg-white/[0.06]') : (isDaylight ? 'hover:bg-black/[0.025]' : 'hover:bg-white/[0.035]')}`}
                        style={{ color: 'var(--text-primary)', opacity: isActive ? 0.95 : 0.55 }}
                    >
                        <span
                            className="absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity"
                            style={{ backgroundColor: accentColor, opacity: isActive ? 1 : 0 }}
                        />
                        <span className="block truncate">{anchor.label}</span>
                    </button>
                );
            })}
        </div>
    );

    return (
        <div className="w-1/3 max-w-[264px] shrink-0 overflow-y-auto custom-scrollbar pr-3 flex flex-col gap-5 border-r border-white/10 pb-4 items-stretch">
            {groups.map((group) => (
                <div key={group.id} className="flex flex-col gap-1">
                    <div
                        className="px-1 pb-1 text-xs font-bold uppercase tracking-widest opacity-50"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        {group.label}
                    </div>
                    {group.items.map((section) => {
                        const Icon = section.icon;
                        const isActive = activeSectionId === section.id;
                        return (
                            <div key={section.id}>
                                <button
                                    type="button"
                                    onClick={() => onSelectSection(section.id)}
                                    className={`w-full p-3 rounded-xl border transition-colors flex items-center justify-between gap-3 text-left ${isActive ? (isDaylight ? 'border-zinc-300/70 bg-white/80' : 'border-white/20 bg-white/10') : (isDaylight ? 'border-transparent hover:bg-white/50' : 'border-transparent hover:bg-white/5')}`}
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <div className="shrink-0 opacity-70" style={{ color: 'var(--text-primary)' }}>
                                            <Icon size={18} />
                                        </div>
                                        <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                            {section.label}
                                        </div>
                                    </div>
                                </button>
                                <AnimatePresence initial={false}>
                                    {isActive && anchors.length > 0 && (
                                        <motion.div
                                            key="toc"
                                            className="overflow-hidden"
                                            initial={reducedMotion ? false : { height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                            transition={EXPAND_TRANSITION}
                                        >
                                            {renderTableOfContents()}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
};

export default SettingsSidebarWide;
