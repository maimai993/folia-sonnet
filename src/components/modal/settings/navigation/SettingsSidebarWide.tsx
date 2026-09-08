import React from 'react';
import type { Theme } from '../../../../types';
import type { SettingsAnchorId } from './settingsAnchorModel';
import type { SettingsNavAnchor, SettingsNavGroup, SettingsSectionId } from './settingsNavModel';
// src/components/modal/settings/navigation/SettingsSidebarWide.tsx
// Wide-layout settings navigation: grouped sections with every subsection table of contents open.

type SettingsSidebarWideProps = {
    groups: SettingsNavGroup[];
    activeSectionId: SettingsSectionId;
    onSelectSection: (sectionId: SettingsSectionId) => void;
    activeAnchorId: string | null;
    onSelectAnchor: (sectionId: SettingsSectionId, anchorId: SettingsAnchorId) => void;
    isDaylight: boolean;
    theme?: Theme;
};

export const SettingsSidebarWide: React.FC<SettingsSidebarWideProps> = ({
    groups,
    activeSectionId,
    onSelectSection,
    activeAnchorId,
    onSelectAnchor,
    isDaylight,
    theme,
}) => {
    const accentColor = theme?.accentColor || (isDaylight ? '#44403c' : '#f4f4f5');

    const renderTableOfContents = (sectionId: SettingsSectionId, anchors: SettingsNavAnchor[]) => (
        <div className="mt-1 flex flex-col gap-0.5 pl-[26px]">
            {anchors.map((anchor) => {
                const isActive = activeSectionId === sectionId && activeAnchorId === anchor.id;
                return (
                    <button
                        key={anchor.id}
                        type="button"
                        title={anchor.label}
                        // The highlight is colour and opacity only; assistive tech and tests need
                        // the state said out loud.
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => onSelectAnchor(sectionId, anchor.id)}
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
                                {section.anchors.length > 0 && renderTableOfContents(section.id, section.anchors)}
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
};

export default SettingsSidebarWide;
