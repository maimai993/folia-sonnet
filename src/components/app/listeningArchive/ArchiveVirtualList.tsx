import React, { useCallback, useMemo } from 'react';
import { List, type RowComponentProps } from 'react-window';

// src/components/app/listeningArchive/ArchiveVirtualList.tsx
// 档案里几个会长到几百上千行的列表（排行、单曲的按日时间轴）共用一条虚拟列表。
//
// 用 react-window（仓库既有依赖，见 shared/CustomSelectMenu 的同一种接法：行组件是普通函数，
// 参数类型写 RowComponentProps<行自己的 props>）。档案的排行是全量算出来的，一年下来歌曲行
// 能有几千条，普通 .map() 会把它们全部挂进 DOM。

export type ArchiveVirtualRow<Row> = React.FC<{ row: Row; index: number }>;

/** 行组件从 rowProps 里拿到的两样东西：整份数据与那一行的渲染器。 */
type ArchiveRowProps = {
    rows: unknown[];
    Row: ArchiveVirtualRow<unknown>;
};

const ArchiveRowAdapter = ({ index, style, rows, Row }: RowComponentProps<ArchiveRowProps>): React.ReactElement | null => {
    const row = rows[index];
    if (row === undefined) return null;
    return (
        <div style={style}>
            <Row row={row} index={index} />
        </div>
    );
};

type ArchiveVirtualListProps<Row> = {
    rows: Row[];
    rowHeight: number;
    itemKey: (row: Row, index: number) => string;
    Row: ArchiveVirtualRow<Row>;
    ariaLabel?: string;
};

export function ArchiveVirtualList<Row>({ rows, rowHeight, itemKey, Row, ariaLabel }: ArchiveVirtualListProps<Row>) {
    const rowProps = useMemo(() => ({ rows: rows as unknown[], Row: Row as ArchiveVirtualRow<unknown> }), [Row, rows]);
    const rowKey = useCallback(
        (index: number, data: ArchiveRowProps) => itemKey(data.rows[index] as Row, index),
        [itemKey],
    );

    return (
        <List
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowComponent={ArchiveRowAdapter}
            rowProps={rowProps}
            rowKey={rowKey}
            overscanCount={6}
            className="custom-scrollbar"
            style={{ height: '100%', width: '100%' }}
            aria-label={ariaLabel}
            role="list"
        />
    );
}

export default ArchiveVirtualList;
