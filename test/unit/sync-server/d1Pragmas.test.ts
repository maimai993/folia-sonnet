// test/unit/sync-server/d1Pragmas.test.ts
// D1 模拟器建库时到底设了哪些 pragma（issue M39）。
//
// README 与 node.ts 一直声称「写操作靠 busy_timeout 互相等待」，但构造函数里从来没设过 ——
// 这个词只出现在注释里。多进程共享同一个库文件时锁冲突会立刻报 SQLITE_BUSY，症状是
// 「偶尔保存失败」，而文档让人以为已经处理过了。
//
// 这条测试直接查真实连接上的 pragma 值：只改注释、只改 README 都会让它红。

import { afterEach, describe, expect, it } from 'vitest';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';

const databases: D1Emulator[] = [];
const create = () => {
    const db = new D1Emulator(':memory:');
    databases.push(db);
    return db;
};

/** better-sqlite3 的 pragma 查询通过 prepare 取，模拟器只暴露了 prepare。 */
const pragmaValue = async (db: D1Emulator, name: string): Promise<number> => {
    const row = await db.prepare(`PRAGMA ${name}`).first<Record<string, number>>();
    return Number(Object.values(row ?? {})[0]);
};

afterEach(() => {
    for (const db of databases.splice(0)) (db as unknown as { db: { close(): void } }).db.close();
});

describe('D1 模拟器的 pragma（M39）', () => {
    /*
     * 断言的是 8000，而不是「大于 0」：better-sqlite3 的默认 busy_timeout 本来就是 5000，
     * 所以「去掉那行 pragma 测试仍然通过」—— 这条测试必须能区分「显式设过」和「靠库默认」。
     * 把期望值与默认值拉开，撤掉那行就会红。
     */
    it('sets busy_timeout explicitly instead of relying on the driver default', async () => {
        const db = create();
        expect(await pragmaValue(db, 'busy_timeout')).toBe(8000);
    });

    /* 顺带钉住其它三项：它们也是「文档说有、实现里别丢」的那一类。 */
    it('keeps WAL and the memory-oriented pragmas', async () => {
        const db = create();
        const journal = await db.prepare('PRAGMA journal_mode').first<{ journal_mode: string }>();
        expect(String(journal?.journal_mode).toLowerCase()).toBe('memory');
        expect(await pragmaValue(db, 'synchronous')).toBe(1);
        expect(await pragmaValue(db, 'temp_store')).toBe(2);
    });
});
