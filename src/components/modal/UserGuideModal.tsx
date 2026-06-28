import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Command, Keyboard, Search, X, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsUiStore } from '../../stores/useSettingsUiStore';
import { COMMAND_PALETTE_COMMANDS } from '../command-palette/commandRegistry';

export const UserGuideModal: React.FC = () => {
    const { t } = useTranslation();
    const isUserGuideModalOpen = useSettingsUiStore(state => state.isUserGuideModalOpen);
    const setIsUserGuideModalOpen = useSettingsUiStore(state => state.setIsUserGuideModalOpen);
    const isDaylight = useSettingsUiStore(state => state.isDaylight);
    const [page, setPage] = useState<1 | 2>(1);

    const bgClass = isDaylight ? 'bg-white border-zinc-200' : 'bg-[#18181b] border-zinc-800';
    const textPrimary = isDaylight ? 'text-zinc-900' : 'text-zinc-50';
    const textSecondary = isDaylight ? 'text-zinc-500' : 'text-zinc-400';
    const closeBtnHover = isDaylight ? 'hover:bg-zinc-200/50' : 'hover:bg-white/10';
    
    // Premium button gradient
    const btnClass = isDaylight 
        ? 'bg-gradient-to-r from-zinc-800 to-zinc-900 hover:from-zinc-700 hover:to-zinc-800 text-white shadow-xl shadow-zinc-900/10' 
        : 'bg-gradient-to-r from-zinc-100 to-white hover:from-white hover:to-zinc-100 text-zinc-900 shadow-xl shadow-white/10';

    const cardBg = isDaylight ? 'bg-zinc-50 border border-zinc-100 hover:bg-zinc-100' : 'bg-zinc-800/50 border border-zinc-700/50 hover:bg-zinc-800';

    const pageVariants = {
        initial: (direction: number) => ({
            x: direction > 0 ? 30 : -30,
            opacity: 0,
            scale: 0.98
        }),
        animate: {
            x: 0,
            opacity: 1,
            scale: 1,
            transition: { type: "spring", stiffness: 300, damping: 25 }
        },
        exit: (direction: number) => ({
            x: direction < 0 ? 30 : -30,
            opacity: 0,
            scale: 0.98,
            transition: { duration: 0.2 }
        })
    };

    return (
        <AnimatePresence>
            {isUserGuideModalOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
                    onClick={() => setIsUserGuideModalOpen(false)}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0, y: 20 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.95, opacity: 0, y: 10 }}
                        transition={{ type: "spring", bounce: 0, duration: 0.5 }}
                        onClick={(e) => e.stopPropagation()}
                        className={`${bgClass} border rounded-[2rem] max-w-lg w-full p-8 shadow-2xl relative overflow-hidden`}
                    >
                        {/* Decorative background blobs */}
                        <div className="absolute inset-0 pointer-events-none z-0">
                            <div className={`absolute -top-24 -right-24 w-64 h-64 rounded-full blur-[80px] ${isDaylight ? 'bg-blue-400/20' : 'bg-blue-500/10'}`} />
                            <div className={`absolute -bottom-24 -left-24 w-64 h-64 rounded-full blur-[80px] ${isDaylight ? 'bg-purple-400/20' : 'bg-purple-500/10'}`} />
                        </div>

                        <button
                            onClick={() => setIsUserGuideModalOpen(false)}
                            className={`absolute top-5 right-5 p-2 rounded-full transition-colors opacity-50 hover:opacity-100 z-10 ${closeBtnHover} ${textPrimary}`}
                        >
                            <X size={20} />
                        </button>

                        <div className="relative z-10">
                            <AnimatePresence mode="wait" custom={page === 1 ? -1 : 1}>
                                {page === 1 ? (
                                    <motion.div
                                        key="page1"
                                        custom={-1}
                                        variants={pageVariants}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        className="flex flex-col h-full"
                                    >
                                        <div className="flex justify-center mb-6 mt-4">
                                            <div className={`relative w-20 h-20 rounded-full flex items-center justify-center ${isDaylight ? 'bg-blue-50 shadow-inner' : 'bg-white/[0.03] shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]'}`}>
                                                <Sparkles size={32} className={isDaylight ? 'text-blue-500' : 'text-blue-400'} />
                                            </div>
                                        </div>

                                        <h2 className={`text-2xl font-extrabold text-center mb-2 tracking-tight ${textPrimary}`}>
                                            {t('userGuide.title', 'Welcome')}
                                        </h2>
                                        <p className={`text-center text-sm mb-10 ${textSecondary}`}>
                                            {t('userGuide.subtitle', 'Here are some tips to help you navigate.')}
                                        </p>

                                        <div className="space-y-4">
                                            <div className={`flex gap-4 items-start p-4 rounded-2xl transition-colors ${cardBg}`}>
                                                <div className={`flex-shrink-0 p-2.5 rounded-xl ${isDaylight ? 'bg-white shadow-sm' : 'bg-white/10'}`}>
                                                    <Keyboard size={20} className={isDaylight ? 'text-blue-500' : 'text-blue-400'} />
                                                </div>
                                                <div>
                                                    <h3 className={`font-bold mb-1 ${textPrimary}`}>
                                                        {t('userGuide.commandPalette.title', 'Command Palette')}
                                                    </h3>
                                                    <p className={`text-sm leading-relaxed ${textSecondary}`}>
                                                        {t('userGuide.commandPalette.desc', 'Press the "s" key on the playback page to open the Command Palette and access commands quickly.')}
                                                    </p>
                                                </div>
                                            </div>

                                            <div className={`flex gap-4 items-start p-4 rounded-2xl transition-colors ${cardBg}`}>
                                                <div className={`flex-shrink-0 p-2.5 rounded-xl ${isDaylight ? 'bg-white shadow-sm' : 'bg-white/10'}`}>
                                                    <Search size={20} className={isDaylight ? 'text-purple-500' : 'text-purple-400'} />
                                                </div>
                                                <div>
                                                    <h3 className={`font-bold mb-1 ${textPrimary}`}>
                                                        {t('userGuide.typeToSearch.title', 'Instant Search')}
                                                    </h3>
                                                    <p className={`text-sm leading-relaxed ${textSecondary}`}>
                                                        {t('userGuide.typeToSearch.desc', 'Press any key in a song list to instantly start searching.')}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mt-10 flex justify-center">
                                            <button
                                                onClick={() => setPage(2)}
                                                className={`py-3.5 px-12 rounded-full font-bold text-sm transition-all hover:scale-105 active:scale-95 ${btnClass}`}
                                            >
                                                {t('userGuide.next', 'Next')}
                                            </button>
                                        </div>
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key="page2"
                                        custom={1}
                                        variants={pageVariants}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        className="flex flex-col h-full"
                                    >
                                        <div className="mt-2 mb-6 text-center">
                                            <h2 className={`text-2xl font-extrabold mb-2 tracking-tight ${textPrimary}`}>
                                                {t('userGuide.page2Title', 'Commands & Shortcuts')}
                                            </h2>
                                            <p className={`text-sm ${textSecondary}`}>
                                                {t('userGuide.page2Subtitle', 'Master shortcuts for the best experience.')}
                                            </p>
                                        </div>

                                        <div className="overflow-y-auto custom-scrollbar max-h-[50vh] pr-4 space-y-8 pb-4">
                                            {/* Shortcuts Section */}
                                            <div>
                                                <h3 className={`text-xs font-bold uppercase tracking-widest mb-4 flex items-center gap-2 opacity-60 ${textPrimary}`}>
                                                    <Keyboard size={14} /> {t('userGuide.shortcuts', 'Shortcuts')}
                                                </h3>
                                                <ul className="space-y-2 text-sm">
                                                    <li className={`flex items-center justify-between p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                                        <span className={`font-medium ${textPrimary}`}>{t('help.openCommandPalette', 'Open Command Palette')}</span>
                                                        <kbd className={`px-2.5 py-1 rounded-md text-xs font-mono shadow-sm ${isDaylight ? 'bg-white border border-zinc-200' : 'bg-white/10'}`}>S</kbd>
                                                    </li>
                                                    <li className={`flex items-center justify-between p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                                        <span className={`font-medium ${textPrimary}`}>{t('help.toggleRightPanel', 'Toggle Right Panel')}</span>
                                                        <kbd className={`px-2.5 py-1 rounded-md text-xs font-mono shadow-sm ${isDaylight ? 'bg-white border border-zinc-200' : 'bg-white/10'}`}>P</kbd>
                                                    </li>
                                                    <li className={`flex items-center justify-between p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                                        <span className={`font-medium ${textPrimary}`}>{t('help.hidePlayerChrome', 'Hide Player Controls')}</span>
                                                        <kbd className={`px-2.5 py-1 rounded-md text-xs font-mono shadow-sm ${isDaylight ? 'bg-white border border-zinc-200' : 'bg-white/10'}`}>H</kbd>
                                                    </li>
                                                    <li className={`flex items-center justify-between p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                                        <span className={`font-medium ${textPrimary}`}>{t('help.browserFullscreen', 'Fullscreen')}</span>
                                                        <kbd className={`px-2.5 py-1 rounded-md text-xs font-mono shadow-sm ${isDaylight ? 'bg-white border border-zinc-200' : 'bg-white/10'}`}>F11</kbd>
                                                    </li>
                                                </ul>
                                            </div>

                                            {/* Commands Section */}
                                            <div>
                                                <h3 className={`text-xs font-bold uppercase tracking-widest mb-2 flex items-center gap-2 opacity-60 ${textPrimary}`}>
                                                    <Command size={14} /> {t('userGuide.commands', 'All Commands')}
                                                </h3>
                                                <p className={`text-xs mb-4 ${textSecondary}`}>
                                                    {t('userGuide.commandsDesc', 'You can trigger commands by typing English, Chinese, or Pinyin.')}
                                                </p>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                    {COMMAND_PALETTE_COMMANDS.filter(c => c.id !== 'queue' && !c.id.startsWith('navigate')).map(cmd => (
                                                        <div key={cmd.id} className={`p-3.5 rounded-xl transition-colors ${cardBg}`}>
                                                            <div className={`font-bold text-sm mb-1 ${textPrimary}`}>{t(`commandPalette.commands.${cmd.id}.title`, cmd.title)}</div>
                                                            <div className={`text-xs ${textSecondary} leading-relaxed`}>{t(`commandPalette.commands.${cmd.id}.description`, cmd.description)}</div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mt-8 pt-4 flex justify-center gap-4 relative">

                                            <button
                                                onClick={() => setPage(1)}
                                                className={`py-3.5 px-8 rounded-full font-bold text-sm transition-all hover:bg-zinc-200/50 dark:hover:bg-white/10 ${textSecondary} hover:${textPrimary}`}
                                            >
                                                {t('userGuide.back', 'Back')}
                                            </button>
                                            <button
                                                onClick={() => setIsUserGuideModalOpen(false)}
                                                className={`py-3.5 px-10 rounded-full font-bold text-sm transition-all hover:scale-105 active:scale-95 ${btnClass}`}
                                            >
                                                {t('userGuide.gotIt', 'Got it')}
                                            </button>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
