import Database from 'better-sqlite3';
import type { D1Database, D1PreparedStatement } from './app.js';

// sync-server/src/d1-emulator.ts
export class D1Emulator implements D1Database {
  private db: Database.Database;
  private executors = new WeakMap<D1PreparedStatement, () => unknown>();

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  close(): void { this.db.close(); }

  prepare(query: string): D1PreparedStatement {
    const createBoundStatement = (boundValues: unknown[]): D1PreparedStatement => {
      const execute = () => this.db.prepare(query).run(...boundValues);
      const statement: D1PreparedStatement = {
        bind: (...values) => createBoundStatement(values),
        first: async <T = Record<string, unknown>>() => (this.db.prepare(query).get(...boundValues) as T | undefined) ?? null,
        all: async <T = Record<string, unknown>>() => ({ results: this.db.prepare(query).all(...boundValues) as T[] }),
        run: async () => execute(),
      };
      this.executors.set(statement, execute);
      return statement;
    };
    return createBoundStatement([]);
  }

  /** 在同步事务里执行同步语句，让异常抛出触发回滚，不能吞进 async rejection。 */
  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    return this.db.transaction(() => statements.map((statement) => {
      const execute = this.executors.get(statement);
      if (!execute) throw new Error('Statement belongs to a different database');
      return execute();
    }))();
  }
}
