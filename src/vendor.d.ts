/**
 * Ambient type declarations for third-party modules without bundled types.
 * Used by the TS migration — keeps @types/* out of devDeps to avoid
 * declaration-emit conflicts with allowJs.
 */

declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface Database {
      prepare(sql: string): Statement;
      exec(sql: string): Database;
      transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
      close(): void;
      pragma(pragma: string, options?: { simple?: boolean }): unknown;
    }

    interface Statement {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): unknown | undefined;
      all(...params: unknown[]): unknown[];
      iterate(...params: unknown[]): IterableIterator<unknown>;
    }

    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }
  }

  function BetterSqlite3(
    filename: string,
    options?: Record<string, unknown>,
  ): BetterSqlite3.Database;
  export = BetterSqlite3;
}
