import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';

// src/components/modal/settings/ShortcutCaptureField.tsx
// A keybinding row, the way a game's control list works: click it, press the key you want, done.
//
// Alt is fixed and shown as a prefix rather than captured, so the listener presses one key and the
// field cannot end up holding a chord nothing dispatches.

type ShortcutCaptureFieldProps = {
    /** The letter currently bound, or null. */
    value: string | null;
    /** Called with the captured letter, or null when cleared. */
    onChange: (letter: string | null) => void;
    /** Refuses a key and says why; the reason is shown under the field. */
    validate: (letter: string) => string | null;
    label: string;
    isDaylight: boolean;
    theme?: Theme;
};

const MODIFIER_KEYS = new Set(['Alt', 'Shift', 'Control', 'Meta', 'AltGraph', 'CapsLock']);

export const ShortcutCaptureField: React.FC<ShortcutCaptureFieldProps> = ({
    value,
    onChange,
    validate,
    label,
    isDaylight,
    theme,
}) => {
    const { t } = useTranslation();
    const [isListening, setIsListening] = useState(false);
    const [rejection, setRejection] = useState<string | null>(null);

    useEffect(() => {
        if (!isListening) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            // Capture phase, and propagation stops here: the app's own global keys are listening
            // for exactly the sort of press being recorded, and a capture must not also fire one.
            event.preventDefault();
            event.stopPropagation();

            // Held down while reaching for the real key.
            if (MODIFIER_KEYS.has(event.key)) {
                return;
            }
            if (event.key === 'Escape') {
                setIsListening(false);
                setRejection(null);
                return;
            }

            const letter = event.key.toLowerCase();
            const reason = validate(letter);
            if (reason) {
                setRejection(reason);
                return;
            }

            onChange(letter);
            setIsListening(false);
            setRejection(null);
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [isListening, onChange, validate]);

    const accentColor = theme?.accentColor || (isDaylight ? '#44403c' : '#f4f4f5');
    const capClass = `inline-flex min-w-9 items-center justify-center rounded-md border px-2 py-1 font-mono text-xs ${
        isDaylight ? 'border-black/15 bg-black/5' : 'border-white/15 bg-white/10'
    }`;
    const slotText = isListening
        ? t('options.customShortcutListening')
        : value
            ? value.toUpperCase()
            : '—';

    return (
        <div className="space-y-1.5">
            <div className="relative">
                <button
                    type="button"
                    onClick={() => {
                        setRejection(null);
                        setIsListening(current => !current);
                    }}
                    onBlur={() => {
                        setIsListening(false);
                        setRejection(null);
                    }}
                    aria-label={label}
                    className="w-full rounded-xl border px-4 py-3 text-left text-sm transition-all focus:outline-none cursor-pointer"
                    style={{
                        backgroundColor: 'var(--overlay-medium)',
                        borderColor: isListening ? accentColor : 'var(--border-color)',
                        color: 'var(--text-primary)',
                    }}
                >
                    {/* Alt is the half the listener does not choose, so it is drawn as a key that is
                        already down rather than as part of the editable value. */}
                    <span className="inline-flex items-center gap-1.5">
                        <span className={`${capClass} opacity-60`}>Alt</span>
                        <span className="opacity-40">+</span>
                        <span
                            data-testid="custom-shortcut-slot"
                            className={`${capClass} ${isListening ? 'animate-pulse' : ''}`}
                            style={isListening ? { borderColor: accentColor, color: accentColor } : undefined}
                        >
                            {slotText}
                        </span>
                    </span>
                </button>
                {value && !isListening && (
                    <button
                        type="button"
                        onClick={() => onChange(null)}
                        aria-label={t('options.customShortcutClear')}
                        title={t('options.customShortcutClear')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 opacity-45 transition-opacity hover:opacity-90 cursor-pointer"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>
            {rejection && (
                <div className="text-[11px]" style={{ color: '#f87171' }}>
                    {rejection}
                </div>
            )}
        </div>
    );
};

export default ShortcutCaptureField;
