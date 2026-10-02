import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// src/library/suites/tui/LibraryTuiPrompt.tsx
// TUI 的行内提示：一行等宽文字，贴在列表下方。改名是一个输入框（Enter 提交、Esc 取消），
// 删除集合是一句确认（Enter 确认、Esc 取消，也可以点两个按钮）。按键在这里处理并截住，
// 不会落到 TUI 的列表按键或命令面板上；进行中时禁用，结果由调用方决定是否关掉。

export type LibraryTuiPromptRequest =
    | { kind: 'rename'; initialValue: string }
    | { kind: 'confirm-delete'; message: string };

type LibraryTuiPromptProps = {
    request: LibraryTuiPromptRequest;
    pending: boolean;
    accentColor: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
};

const LibraryTuiPrompt: React.FC<LibraryTuiPromptProps> = ({ request, pending, accentColor, onSubmit, onCancel }) => {
    const { t } = useTranslation();
    const [value, setValue] = useState(request.kind === 'rename' ? request.initialValue : '');
    const inputRef = useRef<HTMLInputElement>(null);
    const confirmRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (request.kind === 'rename') {
            inputRef.current?.focus();
            inputRef.current?.select();
        } else {
            confirmRef.current?.focus();
        }
    }, [request.kind]);

    // Enter / Escape 归提示本身：截住冒泡，window 上的 TUI 按键与命令面板都看不到。
    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
        } else if (event.key === 'Enter') {
            event.stopPropagation();
            // 焦点在按钮上时让按钮自己响应（Enter 在「取消」上就是取消）。
            if (event.target instanceof HTMLButtonElement) return;
            event.preventDefault();
            if (!pending && !event.repeat) onSubmit(value);
        }
    };

    if (request.kind === 'rename') {
        return (
            <div
                data-tui-prompt="rename"
                className="flex shrink-0 items-center gap-2 border-t border-current/15 px-4 py-1.5 text-[13px]"
            >
                <label htmlFor="library-tui-rename" style={{ color: accentColor }}>{`${t('libraryTui.renamePrompt')}>`}</label>
                <input
                    id="library-tui-rename"
                    ref={inputRef}
                    value={value}
                    disabled={pending}
                    onChange={event => setValue(event.target.value)}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent font-mono outline-none disabled:opacity-50"
                    style={{ color: 'var(--text-primary)', caretColor: accentColor }}
                />
                <span className="shrink-0 opacity-50">{t('libraryTui.promptHint')}</span>
            </div>
        );
    }

    return (
        <div
            ref={confirmRef}
            role="alertdialog"
            aria-label={request.message}
            tabIndex={-1}
            data-tui-prompt="confirm-delete"
            onKeyDown={handleKeyDown}
            className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/15 px-4 py-1.5 text-[13px] outline-none"
        >
            <span className="text-red-500">{request.message}</span>
            <button type="button" disabled={pending} onClick={() => onSubmit('')} className="text-red-500 hover:underline disabled:opacity-40">
                {`[${t('libraryTui.confirm')}]`}
            </button>
            <button type="button" onClick={onCancel} className="opacity-70 hover:opacity-100">
                {`[${t('libraryTui.cancel')}]`}
            </button>
            <span className="opacity-50">{t('libraryTui.promptHint')}</span>
        </div>
    );
};

export default LibraryTuiPrompt;
