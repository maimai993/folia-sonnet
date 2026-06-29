import type React from 'react';

// src/components/modal/UserGuideFooter.tsx

type UserGuideFooterProps = {
    page: number;
    pageCount: number;
    btnClass: string;
    secondaryBtnClass: string;
    backLabel: string;
    nextLabel: string;
    doneLabel: string;
    onBack: () => void;
    onNext: () => void;
};

export const UserGuideFooter: React.FC<UserGuideFooterProps> = ({
    page,
    pageCount,
    btnClass,
    secondaryBtnClass,
    backLabel,
    nextLabel,
    doneLabel,
    onBack,
    onNext,
}) => (
    <div className="mt-8 pt-4 flex justify-center gap-4 relative">
        {page > 1 && (
            <button
                onClick={onBack}
                className={`py-3.5 px-8 rounded-full font-bold text-sm transition-all ${secondaryBtnClass}`}
            >
                {backLabel}
            </button>
        )}
        <button
            onClick={onNext}
            className={`py-3.5 px-10 rounded-full font-bold text-sm transition-all hover:scale-105 active:scale-95 ${btnClass}`}
        >
            {page === pageCount ? doneLabel : nextLabel}
        </button>
    </div>
);
