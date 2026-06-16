import path from 'node:path';
import {
  clearConfigCache,
  loadConfig,
  loadConfigWithProvenance,
  resolveUserConfigPath,
} from '../../infrastructure/config.js';
import {
  getUserConfigConsent,
  listUserConfigConsent,
  REGISTRY_PATH,
  setUserConfigConsent,
} from '../../infrastructure/registry.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'config',
  description: 'Show or manage codegraph configuration (project + user-level global config)',
  options: [
    ['-j, --json', 'Output as JSON'],
    ['--explain', 'Show per-key provenance (default / user / project / env)'],
    ['--enable-global', 'Record consent to apply the global config to this repo'],
    ['--disable-global', 'Record consent to skip the global config for this repo'],
    ['--list-global', 'List all repos with a recorded consent decision'],
  ],
  execute(_args, opts, ctx) {
    const rootDir = path.resolve('.');

    // ── Consent management ─────────────────────────────────────────────

    if (opts.enableGlobal) {
      setUserConfigConsent(rootDir, 'enabled');
      clearConfigCache();
      const globalPath = resolveUserConfigPath();
      if (!globalPath) {
        process.stderr.write(
          `Consent recorded: "enabled" for ${rootDir}\n` +
            `Note: no global config file found. Create one at ~/.config/codegraph/config.json\n`,
        );
      } else {
        process.stderr.write(
          `Consent recorded: "enabled" for ${rootDir}\n` + `Global config: ${globalPath}\n`,
        );
      }
      return;
    }

    if (opts.disableGlobal) {
      setUserConfigConsent(rootDir, 'disabled');
      clearConfigCache();
      process.stderr.write(`Consent recorded: "disabled" for ${rootDir}\n`);
      return;
    }

    if (opts.listGlobal) {
      const entries = listUserConfigConsent(REGISTRY_PATH);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        process.stdout.write('No repos have a recorded global-config consent decision.\n');
        return;
      }
      process.stdout.write('Global config consent decisions:\n\n');
      for (const { path: p, decision } of entries) {
        process.stdout.write(
          `  ${decision === 'enabled' ? '✔' : '✘'} ${decision.padEnd(8)} ${p}\n`,
        );
      }
      return;
    }

    // ── Explain mode ───────────────────────────────────────────────────

    if (opts.explain) {
      const { config, provenance, appliedGlobalPath, consentDecision } = loadConfigWithProvenance(
        rootDir,
        {
          userConfig: ctx.program.opts().userConfig,
        },
      );
      const globalPath = resolveUserConfigPath();
      const consent = getUserConfigConsent(rootDir);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              config,
              provenance,
              appliedGlobalPath,
              globalFilePath: globalPath,
              consentDecision: consentDecision ?? consent ?? 'undecided',
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      // Human-readable explain output
      process.stdout.write('=== Codegraph config provenance ===\n\n');

      const consentStr = consentDecision ?? consent ?? 'undecided';
      process.stdout.write(`Global config file : ${globalPath ?? '(none found)'}\n`);
      process.stdout.write(`Applied this run   : ${appliedGlobalPath ? 'yes' : 'no'}\n`);
      process.stdout.write(`Consent for repo   : ${consentStr}\n`);
      process.stdout.write(
        `  (change with \`codegraph config --enable-global\` or \`--disable-global\`)\n`,
      );

      if (!globalPath) {
        process.stdout.write(
          `\nDiscovery hint: create a global config at ~/.config/codegraph/config.json\n` +
            `then run \`codegraph config --enable-global\` in repos where you want it applied.\n`,
        );
      } else if (!appliedGlobalPath) {
        process.stdout.write(
          `\nDiscovery hint: global config exists but is not applied to this repo.\n` +
            `Run \`codegraph config --enable-global\` to enable it here.\n`,
        );
      }

      process.stdout.write('\n--- Per-key provenance ---\n\n');
      const provenanceEntries = Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b));
      for (const [key, source] of provenanceEntries) {
        process.stdout.write(`  ${source.padEnd(8)} ${key}\n`);
      }
      return;
    }

    // ── Default: print effective config ────────────────────────────────

    const globalPath = resolveUserConfigPath();
    const consent = getUserConfigConsent(rootDir);
    const config = loadConfig(rootDir, { userConfig: ctx.program.opts().userConfig });

    // Print effective config — always JSON; discovery hint only in non-JSON mode
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);

    if (!opts.json && globalPath && !consent) {
      process.stderr.write(
        `\nℹ Global config found at ${globalPath} — not applied to this repo.\n` +
          `  Run \`codegraph config --enable-global\` to opt in, or\n` +
          `  \`codegraph config --disable-global\` to dismiss this notice.\n`,
      );
    }
  },
};
