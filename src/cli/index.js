import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { setVerbose } from '../infrastructure/logger.js';
import { checkForUpdates, printUpdateNotification } from '../infrastructure/update-check.js';
import { ConfigError } from '../shared/errors.js';
import { applyQueryOpts, config, formatSize, resolveNoTests } from './shared/options.js';
import { outputResult } from './shared/output.js';

const __cliDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const pkg = JSON.parse(fs.readFileSync(path.join(__cliDir, '..', '..', 'package.json'), 'utf-8'));

const program = new Command();
program
  .name('codegraph')
  .description('Local code dependency graph tool')
  .version(pkg.version)
  .option('-v, --verbose', 'Enable verbose/debug output')
  .option('--engine <engine>', 'Parser engine: native, wasm, or auto (default: auto)', 'auto')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setVerbose(true);
  })
  .hook('postAction', async (_thisCommand, actionCommand) => {
    const name = actionCommand.name();
    if (name === 'mcp' || name === 'watch') return;
    if (actionCommand.opts().json) return;
    try {
      const result = await checkForUpdates(pkg.version);
      if (result) printUpdateNotification(result.current, result.latest);
    } catch {
      /* never break CLI */
    }
  });

/** Shared context passed to every command's execute(). */
const ctx = { config, resolveNoTests, formatSize, outputResult, program };

/**
 * Register a command definition onto a Commander parent.
 *
 * Command shape:
 *   { name, description, queryOpts?, options?, validate?, execute(args, opts, ctx), subcommands? }
 *
 * - `name` includes positional args, e.g. 'build [dir]' or 'path <from> <to>'
 * - `queryOpts` (boolean) — if true, attaches shared query options
 * - `options` — array of arrays passed to cmd.option(), e.g. [['--depth <n>', 'Max depth', '3']]
 * - `validate(args, opts, ctx)` — return an error string to abort, or falsy to proceed
 * - `execute(args, opts, ctx)` — the action handler
 * - `subcommands` — nested command definitions (for groups like registry, snapshot)
 */
function registerCommand(parent, def) {
  const cmd = parent.command(def.name).description(def.description);

  if (def.queryOpts) applyQueryOpts(cmd);

  for (const opt of def.options || []) {
    cmd.option(...opt);
  }

  if (def.execute) {
    const argCount = (def.name.match(/<[^>]+>|\[[^\]]+\]/g) || []).length;

    cmd.action((...actionArgs) => {
      const args = actionArgs.slice(0, argCount);
      const opts = actionArgs[argCount];

      if (def.validate) {
        const err = def.validate(args, opts, ctx);
        if (err) {
          throw new ConfigError(err);
        }
      }

      return def.execute(args, opts, ctx);
    });
  }

  if (def.subcommands) {
    for (const sub of def.subcommands) {
      registerCommand(cmd, sub);
    }
  }

  return cmd;
}

/**
 * Auto-discover and register all command modules from src/cli/commands/.
 * Each module must export a `command` (single definition) or `commands` (array).
 */
async function discoverCommands() {
  const commandsDir = path.join(__cliDir, 'commands');
  const files = fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (mod.command) {
      registerCommand(program, mod.command);
    }
    if (mod.commands) {
      for (const def of mod.commands) {
        registerCommand(program, def);
      }
    }
  }
}

export async function run() {
  await discoverCommands();
  await program.parseAsync();
}

export { ctx, program, registerCommand };
