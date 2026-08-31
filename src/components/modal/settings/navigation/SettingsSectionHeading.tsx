import React from 'react';
import type { LucideIcon } from 'lucide-react';
// src/components/modal/settings/navigation/SettingsSectionHeading.tsx
// The one heading style for settings sections, replacing the three variants the subviews grew.

type SettingsSectionHeadingProps = {
    icon: LucideIcon;
    label: string;
    /** Separator above the heading, for subviews that run sections together in one column. */
    divider?: boolean;
    className?: string;
};

export const SettingsSectionHeading: React.FC<SettingsSectionHeadingProps> = ({ icon: Icon, label, divider, className }) => (
    <h3
        className={`text-sm font-bold uppercase tracking-wider opacity-50 mb-4 flex items-center gap-2${divider ? ' border-t border-white/10 pt-5' : ''}${className ? ` ${className}` : ''}`}
        style={{ color: 'var(--text-secondary)' }}
    >
        <Icon size={14} /> {label}
    </h3>
);

export default SettingsSectionHeading;
