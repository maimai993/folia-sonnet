import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '../../../../components/ui';
import type { DesktopGrid3DAction } from './DesktopGrid3DSurface';

// src/library/suites/grid/home/GridHomeActions.tsx
// 网格首页右上角的操作排：多个动作收进一个父级展开按钮，窄屏不再一排挤在一起。

interface GridHomeActionsProps {
    actions: DesktopGrid3DAction[];
    /** 与视图胶囊共用的玻璃底，保证两处观感一致。 */
    pillClassName: string;
    textClassName: string;
    activeTextClassName?: string;
    ponderId?: string;
}

const actionPillClass = (
    pillClassName: string,
    textClassName: string,
    activeTextClassName: string | undefined,
    active?: boolean,
) =>
    `flex h-7 w-full items-center gap-1.5 rounded-full px-3 text-xs font-medium backdrop-blur-md transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${pillClassName} ${
        active && activeTextClassName ? activeTextClassName : textClassName
    }`;

export const GridHomeActions: React.FC<GridHomeActionsProps> = ({ actions, pillClassName, textClassName, activeTextClassName, ponderId }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return undefined;
        const closeOnOutside = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', closeOnOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [open]);

    useEffect(() => {
        // 动作变了（换目录、批量选择开关等）就把展开的那一版收回去，免得出一个点不动的旧面板。
        setOpen(false);
    }, [actions]);

    if (actions.length === 0) return null;

    if (actions.length === 1) {
        const [only] = actions;
        return (
            <Button
                onClick={only.onClick}
                disabled={only.disabled}
                title={only.title}
                className={actionPillClass(pillClassName, textClassName, activeTextClassName, only.active)}
            >
                {only.icon}
                <span className="whitespace-nowrap">{only.label}</span>
            </Button>
        );
    }

    return (
        <div ref={rootRef} data-ponder={ponderId} className="pointer-events-auto relative">
            <Button
                onClick={() => setOpen(value => !value)}
                aria-expanded={open}
                title={t('home.gridHomeMoreActions')}
                className={actionPillClass(pillClassName, textClassName, activeTextClassName, open)}
            >
                <span className="whitespace-nowrap">{t('home.gridHomeMoreActions')}</span>
                <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </Button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-9 flex min-w-[10rem] flex-col gap-1 rounded-2xl border border-white/10 bg-black/75 p-1.5 shadow-xl backdrop-blur-md"
                >
                    {actions.map(action => (
                        <Button
                            key={action.id}
                            onClick={() => {
                                setOpen(false);
                                action.onClick();
                            }}
                            disabled={action.disabled}
                            title={action.title}
                            className={actionPillClass(pillClassName, textClassName, activeTextClassName, action.active)}
                        >
                            {action.icon}
                            <span className="whitespace-nowrap">{action.label}</span>
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default GridHomeActions;
