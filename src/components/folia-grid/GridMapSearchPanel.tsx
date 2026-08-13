import type React from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// src/components/folia-grid/GridMapSearchPanel.tsx
// Renders one live basic search field for GridMap names, metadata, and paths.

interface GridMapSearchPanelProps {
    query: string;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onChange: (query: string) => void;
    onDismiss: () => void;
}

const GridMapSearchPanel = ({ query, inputRef, onChange, onDismiss }: GridMapSearchPanelProps) => {
    const { t } = useTranslation();

    return (
        <div className="relative rounded-2xl border shadow-2xl backdrop-blur-2xl theme-glass-panel">
            <div className="flex min-h-12 items-center gap-2 px-3">
                <Search className="h-4 w-4 shrink-0 opacity-40" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={event => onChange(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            onDismiss();
                        }
                    }}
                    placeholder={t('home.gridSearchPlaceholder')}
                    className="min-w-0 flex-1 bg-transparent py-3 text-sm font-medium outline-none placeholder:text-current placeholder:opacity-40"
                    style={{ color: 'var(--text-primary)' }}
                />
                <button
                    type="button"
                    onClick={() => {
                        if (query) {
                            onChange('');
                            requestAnimationFrame(() => inputRef.current?.focus());
                        } else {
                            onDismiss();
                        }
                    }}
                    className="shrink-0 rounded-full p-1.5 opacity-45 transition-opacity hover:opacity-90"
                    aria-label={query ? t('ui.clear') : t('ui.close')}
                >
                    <X size={15} />
                </button>
            </div>
        </div>
    );
};

export default GridMapSearchPanel;
