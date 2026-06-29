import React from 'react';
import { Command, Keyboard, Palette, Search, Sparkles, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CommandPaletteCommand } from '../command-palette/types';
import { UserGuideFeatureCard } from './UserGuideFeatureCard';
import { UserGuideFooter } from './UserGuideFooter';
import { UserGuideTipCard } from './UserGuideTipCard';
import { PLAYER_PAGE_SHORTCUTS, type GuidePage, type UserGuideShortcut } from './userGuideContent';

// src/components/modal/UserGuidePageContent.tsx

type UserGuideClassNames = {
    textPrimary: string;
    textSecondary: string;
    cardBg: string;
    keyBg: string;
    tipCardBg: string;
    iconTileBg: string;
    btnClass: string;
    secondaryBtnClass: string;
};

type UserGuidePageContentProps = {
    page: GuidePage;
    pageCount: number;
    isDaylight: boolean;
    classes: UserGuideClassNames;
    guideCommands: CommandPaletteCommand[];
    onBack: () => void;
    onNext: () => void;
};

export const UserGuidePageContent: React.FC<UserGuidePageContentProps> = ({
    page,
    pageCount,
    isDaylight,
    classes,
    guideCommands,
    onBack,
    onNext,
}) => {
    const { t } = useTranslation();
    const {
        textPrimary,
        textSecondary,
        cardBg,
        keyBg,
        tipCardBg,
        iconTileBg,
        btnClass,
        secondaryBtnClass,
    } = classes;
    const tipCardClasses = { iconTileBg, tipCardBg, textPrimary, textSecondary };
    const featureCardClasses = { iconTileBg, cardBg, textPrimary, textSecondary };

    const renderShortcutKeys = (shortcut: UserGuideShortcut) => (
        <div className="flex items-center gap-1.5 shrink-0">
            {shortcut.keys.map((key, index) => (
                <React.Fragment key={`${shortcut.id}-${key}`}>
                    {index > 0 && <span className={`text-xs ${textSecondary}`}>{shortcut.separator ?? '/'}</span>}
                    <kbd className={`px-2.5 py-1 rounded-md text-xs font-mono shadow-sm ${keyBg}`}>{key}</kbd>
                </React.Fragment>
            ))}
        </div>
    );

    const footer = (
        <UserGuideFooter
            page={page}
            pageCount={pageCount}
            btnClass={btnClass}
            secondaryBtnClass={secondaryBtnClass}
            backLabel={t('userGuide.back', 'Back')}
            nextLabel={t('userGuide.next', 'Next')}
            doneLabel={t('userGuide.gotIt', 'Got it')}
            onBack={onBack}
            onNext={onNext}
        />
    );

    if (page === 1) {
        return (
            <>
                <div className="flex justify-center mb-6 mt-4">
                    <div className={`relative w-20 h-20 rounded-full flex items-center justify-center ${isDaylight ? 'bg-blue-50 shadow-inner' : 'bg-white/[0.03] shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]'}`}>
                        <Sparkles size={32} className={isDaylight ? 'text-blue-500' : 'text-blue-400'} />
                    </div>
                </div>
                <UserGuideTipCard
                    {...tipCardClasses}
                    icon={Sparkles}
                    iconClassName={isDaylight ? 'text-blue-500' : 'text-blue-400'}
                    title={t('userGuide.title', 'Welcome to Folia')}
                    description={t('userGuide.subtitle', 'Here are some tips to help you navigate.')}
                />
                {footer}
            </>
        );
    }

    if (page === 2) {
        return (
            <>
                <UserGuideTipCard
                    {...tipCardClasses}
                    icon={Search}
                    iconClassName={isDaylight ? 'text-purple-500' : 'text-purple-400'}
                    title={t('userGuide.typeToSearch.title', 'Instant Search')}
                    description={t('userGuide.typeToSearch.desc', 'Press any key in a song list to instantly start searching.')}
                />
                <div className="mt-5 space-y-3">
                    <div className={`p-4 rounded-xl transition-colors ${cardBg}`}>
                        <div className={`font-bold text-sm mb-1 ${textPrimary}`}>
                            {t('userGuide.posterSearch.entryTitle', 'Start from a poster wall')}
                        </div>
                        <div className={`text-xs ${textSecondary} leading-relaxed`}>
                            {t('userGuide.posterSearch.entryDesc', 'When a song poster wall is focused, type letters, numbers, or Chinese characters to search the current list.')}
                        </div>
                    </div>
                    <div className={`p-4 rounded-xl transition-colors ${cardBg}`}>
                        <div className={`font-bold text-sm mb-1 ${textPrimary}`}>
                            {t('userGuide.posterSearch.escapeTitle', 'Close search')}
                        </div>
                        <div className="flex items-center justify-between gap-4">
                            <div className={`text-xs ${textSecondary} leading-relaxed`}>
                                {t('userGuide.posterSearch.escapeDesc', 'Press Esc to close the poster-wall search panel.')}
                            </div>
                            <kbd className={`px-2.5 py-1 rounded-md text-xs font-mono shadow-sm ${keyBg}`}>Esc</kbd>
                        </div>
                    </div>
                </div>
                {footer}
            </>
        );
    }

    if (page === 3) {
        return (
            <>
                <UserGuideTipCard
                    {...tipCardClasses}
                    icon={Keyboard}
                    iconClassName={isDaylight ? 'text-blue-500' : 'text-blue-400'}
                    title={t('userGuide.shortcutsPageTitle', 'Player shortcuts')}
                    description={t('userGuide.shortcutsPageSubtitle', 'Keyboard controls available on the player page.')}
                />
                <div className="mt-5 overflow-y-auto custom-scrollbar max-h-[44vh] pr-4 pb-2">
                    <ul className="space-y-2 text-sm">
                        {PLAYER_PAGE_SHORTCUTS.map(shortcut => (
                            <li key={shortcut.id} className={`flex items-center justify-between gap-4 p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                <span className={`font-medium min-w-0 ${textPrimary}`}>{t(shortcut.titleKey, shortcut.fallback)}</span>
                                {renderShortcutKeys(shortcut)}
                            </li>
                        ))}
                    </ul>
                </div>
                {footer}
            </>
        );
    }

    if (page === 4) {
        return (
            <>
                <UserGuideTipCard
                    {...tipCardClasses}
                    icon={Command}
                    iconClassName={isDaylight ? 'text-blue-500' : 'text-blue-400'}
                    title={t('userGuide.commandPalette.title', 'Command Palette')}
                    description={t('userGuide.commandPalette.desc', 'Press the "s" key on the playback page to open the Command Palette and access commands quickly.')}
                />
                <div className="mt-5 overflow-y-auto custom-scrollbar max-h-[44vh] pr-4 pb-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {guideCommands.map(cmd => (
                            <div key={cmd.id} className={`p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                <div className={`font-bold text-sm mb-1 ${textPrimary}`}>{t(`commandPalette.commands.${cmd.id}.title`, cmd.title)}</div>
                                <div className={`text-xs ${textSecondary} leading-relaxed`}>{t(`commandPalette.commands.${cmd.id}.description`, cmd.description)}</div>
                            </div>
                        ))}
                    </div>
                </div>
                {footer}
            </>
        );
    }

    return (
        <>
            <UserGuideTipCard
                {...tipCardClasses}
                icon={Palette}
                iconClassName={isDaylight ? 'text-rose-500' : 'text-rose-300'}
                title={t('userGuide.theme.title', 'Color themes')}
                description={t('userGuide.theme.desc', 'Customize Folia with your own light and dark color themes, or generate an AI theme from the current song.')}
            />
            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={Palette}
                    iconClassName={isDaylight ? 'text-rose-500' : 'text-rose-300'}
                    title={t('options.openThemePark', 'Open Theme Park')}
                    description={t('userGuide.theme.customDesc', 'Open Theme Park from visual settings or the command palette to edit and save custom light and dark colors.')}
                />
                <UserGuideFeatureCard
                    {...featureCardClasses}
                    icon={WandSparkles}
                    iconClassName={isDaylight ? 'text-purple-500' : 'text-purple-300'}
                    title={t('ui.generateAITheme', 'Generate AI Theme')}
                    description={t('userGuide.theme.aiDesc', 'When AI theme settings are configured, Folia can create song-aware colors and optionally auto-apply cached song themes.')}
                />
            </div>
            {footer}
        </>
    );
};
