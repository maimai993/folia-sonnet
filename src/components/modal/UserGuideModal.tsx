import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { X } from 'lucide-react';
import { useSettingsUiStore } from '../../stores/useSettingsUiStore';
import { COMMAND_PALETTE_COMMANDS } from '../command-palette/commandRegistry';
import type { Theme } from '../../types';
import { UserGuidePageContent } from './UserGuidePageContent';
import { USER_GUIDE_PAGE_COUNT, type GuidePage } from './userGuideContent';

export const UserGuideModal: React.FC<{ theme?: Theme | null }> = ({ theme }) => {
    const isUserGuideModalOpen = useSettingsUiStore(state => state.isUserGuideModalOpen);
    const setIsUserGuideModalOpen = useSettingsUiStore(state => state.setIsUserGuideModalOpen);
    const isDaylight = useSettingsUiStore(state => state.isDaylight);
    const [page, setPage] = useState<GuidePage>(1);
    const [direction, setDirection] = useState(1);

    const bgClass = isDaylight ? 'bg-white border-zinc-200' : 'bg-[#18181b] border-zinc-800';
    const textPrimary = isDaylight ? 'text-zinc-900' : 'text-zinc-50';
    const textSecondary = isDaylight ? 'text-zinc-500' : 'text-zinc-400';
    const closeBtnHover = isDaylight ? 'hover:bg-zinc-200/50' : 'hover:bg-white/10';
    const btnClass = isDaylight
        ? 'bg-gradient-to-r from-zinc-800 to-zinc-900 hover:from-zinc-700 hover:to-zinc-800 text-white shadow-xl shadow-zinc-900/10'
        : 'bg-gradient-to-r from-zinc-100 to-white hover:from-white hover:to-zinc-100 text-zinc-900 shadow-xl shadow-white/10';
    const secondaryBtnClass = isDaylight
        ? 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/50'
        : 'text-zinc-400 hover:text-zinc-50 hover:bg-white/10';
    const cardBg = isDaylight
        ? 'bg-zinc-50 border border-zinc-100 hover:bg-zinc-100'
        : 'bg-zinc-800/50 border border-zinc-700/50 hover:bg-zinc-800';
    const keyBg = isDaylight ? 'bg-white border border-zinc-200' : 'bg-white/10';
    const tipCardBg = isDaylight ? 'bg-zinc-50/90 border-zinc-100' : 'bg-white/[0.04] border-white/10';
    const iconTileBg = isDaylight ? 'bg-white shadow-sm' : 'bg-white/10';
    const guideCommands = COMMAND_PALETTE_COMMANDS.filter(c => c.id !== 'queue' && !c.id.startsWith('navigate'));

    const goToPage = (nextPage: GuidePage) => {
        setDirection(nextPage > page ? 1 : -1);
        setPage(nextPage);
    };

    const goNext = () => {
        if (page >= USER_GUIDE_PAGE_COUNT) {
            setIsUserGuideModalOpen(false);
            return;
        }

        goToPage((page + 1) as GuidePage);
    };

    const goBack = () => {
        if (page <= 1) {
            return;
        }

        goToPage((page - 1) as GuidePage);
    };

    const pageVariants: Variants = {
        initial: (direction: number) => ({
            x: direction > 0 ? 30 : -30,
            opacity: 0,
            scale: 0.98
        }),
        animate: {
            x: 0,
            opacity: 1,
            scale: 1,
            transition: { type: 'spring', stiffness: 300, damping: 25 }
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
                        transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                        onClick={(e) => e.stopPropagation()}
                        className={`${bgClass} border rounded-[2rem] max-w-xl w-full p-8 shadow-2xl relative overflow-hidden`}
                    >
                        <div className="absolute inset-0 pointer-events-none z-0">
                            <div
                                className={`absolute -top-24 -right-24 w-64 h-64 rounded-full blur-[80px] ${isDaylight ? 'opacity-20' : 'opacity-10'}`}
                                style={{ backgroundColor: theme?.accentColor || (isDaylight ? '#60a5fa' : '#3b82f6') }}
                            />
                            <div
                                className={`absolute -bottom-24 -left-24 w-64 h-64 rounded-full blur-[80px] ${isDaylight ? 'opacity-20' : 'opacity-10'}`}
                                style={{ backgroundColor: theme?.secondaryColor || theme?.accentColor || (isDaylight ? '#c084fc' : '#a855f7') }}
                            />
                        </div>

                        <button
                            onClick={() => setIsUserGuideModalOpen(false)}
                            className={`absolute top-5 right-5 p-2 rounded-full transition-colors opacity-50 hover:opacity-100 z-10 ${closeBtnHover} ${textPrimary}`}
                        >
                            <X size={20} />
                        </button>

                        <div className="relative z-10">
                            <AnimatePresence mode="wait" custom={direction}>
                                <motion.div
                                    key={`page-${page}`}
                                    custom={direction}
                                    variants={pageVariants}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    className="flex flex-col h-full"
                                >
                                    <UserGuidePageContent
                                        page={page}
                                        pageCount={USER_GUIDE_PAGE_COUNT}
                                        isDaylight={isDaylight}
                                        classes={{
                                            textPrimary,
                                            textSecondary,
                                            cardBg,
                                            keyBg,
                                            tipCardBg,
                                            iconTileBg,
                                            btnClass,
                                            secondaryBtnClass,
                                        }}
                                        guideCommands={guideCommands}
                                        onBack={goBack}
                                        onNext={goNext}
                                    />
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
