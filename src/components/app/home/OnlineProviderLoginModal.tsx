import { Loader2, RotateCcw, X } from 'lucide-react';
import { motion } from 'framer-motion';

// src/components/app/home/OnlineProviderLoginModal.tsx

type OnlineProviderLoginModalProps = {
    title: string;
    note: string;
    qrCodeImg: string;
    statusText: string;
    state: 'idle' | 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
    retryLabel: string;
    closeLabel: string;
    onRetry: () => void;
    onClose: () => void;
};

const OnlineProviderLoginModal = ({
    title,
    note,
    qrCodeImg,
    statusText,
    state,
    retryLabel,
    closeLabel,
    onRetry,
    onClose,
}: OnlineProviderLoginModalProps) => {
    const canRetry = state === 'expired' || state === 'error';
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4"
            role="dialog"
            aria-modal="true"
            aria-label={title}
        >
            <motion.div
                initial={{ scale: 0.92, opacity: 0, y: 24 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.92, opacity: 0, y: 12 }}
                transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
                className="bg-zinc-900/90 border border-white/10 p-8 rounded-3xl max-w-sm w-full text-center relative shadow-2xl"
            >
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={closeLabel}
                    className="absolute top-4 right-4 opacity-40 hover:opacity-100 rounded-full bg-white/5 p-1 transition-colors cursor-pointer"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <X size={16} />
                </button>
                <h3 className="text-lg font-bold mb-6" style={{ color: 'var(--text-primary)' }}>{title}</h3>
                <div className="relative inline-block bg-white p-2 rounded-xl mb-4 shadow-inner">
                    {qrCodeImg ? (
                        <img src={qrCodeImg} alt="QR Code" className="w-40 h-40" />
                    ) : (
                        <div className="w-40 h-40 flex items-center justify-center bg-gray-100 rounded-lg">
                            <Loader2 className="animate-spin text-gray-400" size={24} />
                        </div>
                    )}
                </div>
                <p className={`text-xs font-medium mt-2 ${state === 'confirmed' ? 'text-green-400' : 'opacity-60'}`} style={{ color: state === 'confirmed' ? undefined : 'var(--text-secondary)' }}>
                    {statusText}
                </p>
                {canRetry && (
                    <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 text-xs font-semibold transition-colors">
                        <RotateCcw size={13} />
                        {retryLabel}
                    </button>
                )}
                <p className="text-[10px] opacity-30 mt-6" style={{ color: 'var(--text-secondary)' }}>{note}</p>
            </motion.div>
        </motion.div>
    );
};

export default OnlineProviderLoginModal;
