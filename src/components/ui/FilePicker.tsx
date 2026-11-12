// src/components/ui/FilePicker.tsx
// 隐藏的文件选择控件：只提供 `open()` 和 `onFile`，界面自己决定用哪颗按钮触发。
//
// 为什么要有它：`<input type="file">` 是浏览器里唯一能拉起系统文件选择器的途径，
// 但它必须是真实标签 —— 而控件库之外不允许手写控件（ci/uiPolicy.ts）。
// 所以真正的标签留在这里，调用方只拿一个 ref 和一个回调。

import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';

export interface FilePickerHandle {
    /** 拉起系统文件选择器。 */
    open: () => void;
}

export interface FilePickerProps {
    /** 选完文件后回调。同一个文件连选两次也会触发。 */
    onFile: (file: File) => void;
    /** 给 `accept` 属性，例如 `.zip,application/zip`。 */
    accept?: string;
    /** 是否允许一次选多个（默认否）。 */
    multiple?: boolean;
}

export const FilePicker = forwardRef<FilePickerHandle, FilePickerProps>(({
    onFile, accept, multiple = false,
}, ref) => {
    const inputRef = useRef<HTMLInputElement | null>(null);

    const open = useCallback(() => {
        inputRef.current?.click();
    }, []);

    useImperativeHandle(ref, () => ({ open }), [open]);

    const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files && files.length > 0) {
            onFile(files[0]);
        }
        // 清空，否则选同一个文件不会再触发 change。
        event.target.value = '';
    }, [onFile]);

    return (
        <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={multiple}
            className="hidden"
            onChange={handleChange}
        />
    );
});

FilePicker.displayName = 'FilePicker';

export default FilePicker;
