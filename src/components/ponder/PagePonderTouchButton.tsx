import React from 'react';
import { Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { usePonderStore } from '../../stores/usePonderStore';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { openCurrentPagePonder } from '../../services/ponder/pagePonderTarget';

// src/components/ponder/PagePonderTouchButton.tsx

type PagePonderTouchButtonProps = {
    accent: string;
    isDaylight: boolean;
};

/** Touch-only equivalent of Ctrl+G. It deliberately has no component-target API. */
const PagePonderTouchButton: React.FC<PagePonderTouchButtonProps> = ({ accent, isDaylight }) => {
    const { t } = useTranslation();
    const isCoarsePointer = useMediaQuery('(any-pointer: coarse)');
    const hasSession = usePonderStore(state => state.session !== null);
    const isOnboardingOpen = useSettingsModalStore(state => state.isUserGuideModalOpen);

    if (!isCoarsePointer || hasSession || isOnboardingOpen) {
        return null;
    }

    return (
        <button
            type="button"
            data-testid="page-ponder-touch-button"
            onClick={openCurrentPagePonder}
            aria-label={t('ponder.openPage')}
            title={t('ponder.openPage')}
            className={`fixed bottom-5 right-5 z-[190] flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-transform active:scale-95 ${
                isDaylight ? 'border-black/10 bg-white/80' : 'border-white/15 bg-zinc-900/80'
            }`}
            style={{ color: accent }}
        >
            <Lightbulb size={20} aria-hidden="true" />
        </button>
    );
};

export default PagePonderTouchButton;
