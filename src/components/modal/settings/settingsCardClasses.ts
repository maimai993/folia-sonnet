// src/components/modal/settings/settingsCardClasses.ts
// The card and toggle-track classes the options panel dresses its sections with.
//
// Declared here rather than inline in SettingsModal because a settings section can now be rendered
// outside it — the command palette hosts GridViewSettingsSection on a surface — and a section that
// carries the panel's look must not depend on a second hand-kept copy of these strings.
// LabSettingsModal keeps its own pair on purpose: it sits on a different panel background.

export const settingsCardClassFor = (isDaylight: boolean) => (
    isDaylight ? 'bg-black/[0.025] border-black/10' : 'bg-white/5 border-white/5'
);

export const settingsToggleOffClassFor = (isDaylight: boolean) => (
    isDaylight ? 'bg-zinc-300/90' : 'bg-white/10'
);
