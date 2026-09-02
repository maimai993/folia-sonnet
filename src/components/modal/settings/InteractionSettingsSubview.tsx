import React from 'react';
import { Keyboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// src/components/modal/settings/InteractionSettingsSubview.tsx
// Where the command palette's and the keyboard's own settings will live.
//
// Deliberately empty for now: the section exists so that the settings a listener would look for
// under "how do I drive this app" has a place to be, rather than being scattered into whichever
// panel each one happened to be built next to. Nothing has moved in yet.

type InteractionSettingsSubviewProps = {
    settingsCardClass: string;
};

export const InteractionSettingsSubview: React.FC<InteractionSettingsSubviewProps> = ({ settingsCardClass }) => {
    const { t } = useTranslation();

    return (
        <div className={`${settingsCardClass} flex flex-col items-center gap-3 px-6 py-12 text-center`}>
            <Keyboard size={26} className="opacity-30" />
            <p className="text-sm opacity-50" style={{ color: 'var(--text-secondary)' }}>
                {t('options.interactionSettingsEmpty')}
            </p>
        </div>
    );
};

export default InteractionSettingsSubview;
