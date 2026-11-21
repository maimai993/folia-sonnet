import Database from 'better-sqlite3';
import type { D1Database, D1PreparedStatement } from './app.js';

/*
 * 语句缓存。
 *
 * 原来每次 first/all/run 都重新 `db.prepare()` —— 每条 SQL 每次执行都要重新解析编译。
 * 查询都走这里的缓存后，同一句 SQL 只编译一次；缓存按粗粒度整体清空兜底（路由里的
 * SQL 都是固定写法的字符串，实际条目远到不了上限）。
 */
const MAX_CACHED_STATEMENTS = 512;

export class D1Emulator implements D1Database {
  private db: Database.Database;
  private statements = new Map<string, Database.Statement>();
  private runners = new WeakMap<D1PreparedStatement, () => unknown>();

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    /*
     * 写锁冲突时等一会儿再重试（issue M39）。
     *
     * README 与 node.ts 一直声称「写操作靠 busy_timeout 互相等待」，但这里从来没有设过 ——
     * 这个词只出现在注释里。查下来 better-sqlite3 的默认值**恰好也是 5000**，所以行为上
     * 并没有 issue 说的那种「立刻 SQLITE_BUSY」的随机失败，那条判断是错的。
     *
     * 但「文档说有、代码里找不到」仍然是个真问题：这是一条隐式依赖库默认值的保障，
     * 换驱动、换版本或者有人为了「更严谨」显式传个 timeout 选项，它就可能无声消失。
     * 所以照样写成显式的，并且用 8000 而不是默认的 5000 —— 不是为了更久，
     * 是为了**和默认值不同**，这样测试才能真正证明这行代码被执行过。
     *
     * 8 秒：够跨过若干次写事务（本项目的事务都是毫秒级），又短于上游请求超时。
     */
    this.db.pragma('busy_timeout = 8000');
    /*
     * WAL + NORMAL：崩溃不丢事务（掉电才可能丢最后一笔），写入不再每笔都 fsync。
     * 其余三项：临时表与排序放内存、页缓存给到 64MB、mmap 只读页直接映射——
     * 10w 行的库最怕的就是每次扫描都从页缓存里被挤出去。
     */
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -65536');
    this.db.pragma('mmap_size = 268435456');
  }

  /** 供定时任务做 `PRAGMA optimize`（更新统计信息），Node 侧独有，Workers 上没有。 */
  optimize(): void {
    try {
      this.db.pragma('optimize');
    } catch {
      // 统计信息更新失败不影响服务。
    }
  }

  private statement(query: string): Database.Statement {
    let stmt = this.statements.get(query);
    if (!stmt) {
      stmt = this.db.prepare(query);
      if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear();
      this.statements.set(query, stmt);
    }
    return stmt;
  }

  prepare(query: string): D1PreparedStatement {
    const createBoundStatement = (boundValues: unknown[]): D1PreparedStatement => {
      const run = () => {
        this.statement(query).run(...boundValues);
        return {};
      };
      const statement: D1PreparedStatement = {
        bind: (...values: unknown[]) => createBoundStatement(values),
        first: async <T = Record<string, unknown>>() => {
          const result = this.statement(query).get(...boundValues) as T | undefined;
          return result ?? null;
        },
        all: async <T = Record<string, unknown>>() => {
          const results = this.statement(query).all(...boundValues) as T[];
          return { results };
        },
        run: async () => run(),
      };
      this.runners.set(statement, () => {
        const stmt = this.statement(query);
        // D1 batch also returns rows for SELECT / PRAGMA / RETURNING statements.
        if (stmt.reader) return { results: stmt.all(...boundValues) };
        return run();
      });
      return statement;
    };
    return createBoundStatement([]);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    // Validate ownership before any statement runs, including statements with external side effects.
    const runners = statements.map((statement) => {
      const run = this.runners.get(statement);
      if (!run) throw new Error('D1 batch statement belongs to another database');
      return run;
    });
    // Native SQLite transactions must observe synchronous throws, not rejected run() promises.
    return this.db.transaction(() => runners.map((run) => run()))();
  }
}
