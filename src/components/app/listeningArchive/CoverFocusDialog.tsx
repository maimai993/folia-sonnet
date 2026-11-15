import React from 'react';
import ThemedDialog from '../../shared/ThemedDialog';
import type { ArchiveFocusedCover } from './listeningArchiveStore';

// src/components/app/listeningArchive/CoverFocusDialog.tsx
// 点排行里的封面之后看大图：封面与它说明的是哪一首（标题 + 副标题）。
//
// 用共用的 ThemedDialog（外框、Esc、焦点都在那里），仓库里没有别处现成的封面放大工具，
// 这一层就是那一小块。没有封面时列表里那颗按钮是禁用的，所以这里不必再兜空。

type CoverFocusDialogProps = {
    cover: ArchiveFocusedCover | null;
    isDaylight: boolean;
    onClose: () => void;
};

const CoverFocusDialog: React.FC<CoverFocusDialogProps> = ({ cover, isDaylight, onClose }) => (
    <ThemedDialog
        isOpen={cover !== null}
        onClose={onClose}
        isDaylight={isDaylight}
        size="m"
        title={cover?.title ?? ''}
        description={cover?.subtitle || undefined}
    >
        {cover && (
            <img
                src={cover.url}
                alt=""
                className="max-h-[62vh] w-full rounded-xl bg-[var(--st-fill)] object-contain"
            />
        )}
    </ThemedDialog>
);

export default CoverFocusDialog;
