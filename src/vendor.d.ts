/**
 * Ambient type declarations for third-party modules without bundled types.
 * Used by the TS migration — keeps @types/* out of devDeps to avoid
 * declaration-emit conflicts with allowJs.
 */

declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface Database {
      prepare<TRow = unknown>(sql: string): Statement<TRow>;
      exec(sql: string): Database;
      // biome-ignore lint/suspicious/noExplicitAny: must match better-sqlite3's generic Transaction<F>
      transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
      close(): void;
      pragma(pragma: string, options?: { simple?: boolean }): unknown;
      readonly open: boolean;
      readonly name: string;
    }

    interface Statement<TRow = unknown> {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): TRow | undefined;
      all(...params: unknown[]): TRow[];
      iterate(...params: unknown[]): IterableIterator<TRow>;
      raw(toggle?: boolean): this;
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
