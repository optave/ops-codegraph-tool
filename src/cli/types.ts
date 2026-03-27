import type { Command } from 'commander';

/**
 * Commander options are inherently dynamic — the set of keys depends on
 * how each command defines its `.option()` calls at runtime.  Using a
 * concrete index-signature type (`Record<string, …>`) triggers
 * `noPropertyAccessFromIndexSignature` and forces bracket notation
 * everywhere, which hurts readability for no safety gain.  A dedicated
 * opaque alias keeps the intent clear while allowing dot access.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandOpts = any;

/** Shape of the shared context passed to every command's execute(). */
export interface CliContext {
  config: CommandOpts;
  resolveNoTests: (opts: CommandOpts) => boolean;
  resolveQueryOpts: (opts: CommandOpts) => CommandOpts;
  formatSize: (bytes: number) => string;
  outputResult: (data: unknown, key: string, opts: CommandOpts) => boolean;
  program: Command;
}

/** Shape of a command definition registered via registerCommand(). */
export interface CommandDefinition {
  name: string;
  description: string;
  queryOpts?: boolean;
  options?: Array<[string, string, ...unknown[]]>;
  validate?(args: string[], opts: CommandOpts, ctx: CliContext): string | undefined;
  execute?(args: string[], opts: CommandOpts, ctx: CliContext): void | Promise<void>;
  subcommands?: CommandDefinition[];
}
