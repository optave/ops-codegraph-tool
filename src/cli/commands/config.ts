import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearConfigCache,
  DEFAULTS,
  getDefaultUserConfigPath,
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
import { formatTable } from '../../presentation/table.js';
import type { ConfigSource } from '../../types.js';
import type { CommandDefinition } from '../types.js';

/**
 * Recursively flatten a nested config object to dot-notation key/value pairs.
 * Arrays and null values are serialised to strings.
 */
function flattenConfig(
  obj: Record<string, unknown>,
  prefix = '',
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenConfig(v as Record<string, unknown>, fullKey));
    } else if (Array.isArray(v)) {
      out.push({ key: fullKey, value: v.length === 0 ? '[]' : JSON.stringify(v) });
    } else {
      out.push({ key: fullKey, value: v === null ? 'null' : String(v) });
    }
  }
  return out;
}

/**
 * Expand a top-level provenance map (e.g. { build: 'project' }) to cover every
 * flattened dot-notation key (e.g. 'build.incremental' → 'project').
 */
function expandProvenance(
  flatEntries: Array<{ key: string; value: string }>,
  provenance: Record<string, ConfigSource>,
): Map<string, ConfigSource> {
  const map = new Map<string, ConfigSource>();
  for (const { key } of flatEntries) {
    // Provenance is keyed by top-level section (e.g. 'build', 'llm'), so
    // extract the first segment to find the governing provenance entry.
    const topLevel = key.split('.')[0] ?? key;
    map.set(key, provenance[topLevel] ?? 'default');
  }
  return map;
}

/**
 * Render the effective config as a human-readable Key/Value/Source table.
 * All rows are shown, sorted so non-default overrides appear first, then
 * remaining defaults alphabetically.
 */
function renderConfigTable(
  config: Record<string, unknown>,
  provenance: Record<string, ConfigSource>,
): string {
  const flat = flattenConfig(config);
  const sourceMap = expandProvenance(flat, provenance);

  // Show all entries — sorting non-defaults first, then alphabetically
  const rows = flat
    .slice()
    .sort((a, b) => {
      const sa = sourceMap.get(a.key) ?? 'default';
      const sb = sourceMap.get(b.key) ?? 'default';
      // Non-defaults first
      if (sa !== 'default' && sb === 'default') return -1;
      if (sa === 'default' && sb !== 'default') return 1;
      return a.key.localeCompare(b.key);
    })
    .map(({ key, value }) => [key, value, sourceMap.get(key) ?? 'default']);

  const keyWidth = Math.max(3, ...rows.map((r) => r[0]!.length));
  const valWidth = Math.max(5, ...rows.map((r) => r[1]!.length));
  // Source column is always short ('default', 'user', 'project', 'env')
  const srcWidth = 7;

  return `${formatTable({
    columns: [
      { header: 'Key', width: keyWidth },
      { header: 'Value', width: valWidth },
      { header: 'Source', width: srcWidth },
    ],
    rows: rows as string[][],
    indent: 0,
  })}\n`;
}

/**
 * Build a scaffolded global config JSON file.
 * Produces valid JSON with common sections pre-populated at their defaults.
 * Uses DEFAULTS so the values always reflect the current schema.
 *
 * All keys are optional — users can delete sections they don't need.
 */
function buildInitTemplate(): string {
  // Build a plain object — no comments in JSON, but keep it self-explanatory.
  // Unknown top-level keys are silently ignored by mergeConfig.
  const template: Record<string, unknown> = {
    // LLM provider for AI features (codegraph explain, context, etc.)
    // Use apiKeyCommand to pull the key from a secret manager at runtime.
    // Scope to specific repos with:
    //   { "appliesTo": ["~/projects/*"], "config": { ... } }
    llm: {
      provider: DEFAULTS.llm.provider,
      model: DEFAULTS.llm.model,
      baseUrl: DEFAULTS.llm.baseUrl,
      apiKey: DEFAULTS.llm.apiKey,
      apiKeyCommand: DEFAULTS.llm.apiKeyCommand,
    },

    query: {
      defaultDepth: DEFAULTS.query.defaultDepth,
      defaultLimit: DEFAULTS.query.defaultLimit,
      excludeTests: DEFAULTS.query.excludeTests,
    },

    build: {
      incremental: DEFAULTS.build.incremental,
      typescriptResolver: DEFAULTS.build.typescriptResolver,
    },

    ci: {
      failOnCycles: DEFAULTS.ci.failOnCycles,
      impactThreshold: DEFAULTS.ci.impactThreshold,
    },

    search: {
      defaultMinScore: DEFAULTS.search.defaultMinScore,
      topK: DEFAULTS.search.topK,
    },
  };

  return `${JSON.stringify(template, null, 2)}\n`;
}

export const command: CommandDefinition = {
  name: 'config',
  description: 'Show or manage codegraph configuration (project + user-level global config)',
  options: [
    ['-j, --json', 'Output as JSON'],
    ['--explain', 'Show per-key provenance (default / user / project / env)'],
    ['--enable-global', 'Record consent to apply the global config to this repo'],
    ['--disable-global', 'Record consent to skip the global config for this repo'],
    ['--list-global', 'List all repos with a recorded consent decision'],
    [
      '--init',
      'Scaffold a global config file at the default XDG location with all sections pre-populated',
    ],
    ['--edit', 'Open the global config file in $EDITOR (prints the path if $EDITOR is unset)'],
  ],
  execute(_args, opts, ctx) {
    const rootDir = path.resolve('.');

    // ── Init: scaffold global config ───────────────────────────────────

    if (opts.init) {
      const targetPath = getDefaultUserConfigPath();
      if (fs.existsSync(targetPath)) {
        process.stderr.write(
          `Global config already exists at ${targetPath}\n` +
            `Run \`codegraph config --edit\` to open it, or delete it and re-run --init.\n`,
        );
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, buildInitTemplate(), 'utf-8');
      process.stdout.write(`Created global config at ${targetPath}\n`);
      process.stdout.write(
        `Next steps:\n` +
          `  1. Edit the file: codegraph config --edit\n` +
          `  2. Enable it for this repo: codegraph config --enable-global\n`,
      );
      return;
    }

    // ── Edit: open global config in $EDITOR ────────────────────────────

    if (opts.edit) {
      // Prefer the existing file; fall back to the default path so the user
      // can create-and-edit in one step even before running --init.
      const filePath = resolveUserConfigPath() ?? getDefaultUserConfigPath();

      const editor = process.env.EDITOR || process.env.VISUAL;
      if (!editor) {
        process.stdout.write(`${filePath}\n`);
        process.stderr.write(
          `$EDITOR is not set. Set it in your shell profile (e.g. export EDITOR=nano)\n` +
            `or open the file manually at the path printed above.\n`,
        );
        return;
      }

      // Ensure the directory exists so the editor can create the file
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      const result = spawnSync(editor, [filePath], { stdio: 'inherit' });
      if (result.error) {
        process.stderr.write(`Failed to launch editor "${editor}": ${result.error.message}\n`);
        process.exit(1);
      }
      if (result.status !== 0) {
        process.exit(result.status ?? 1);
      }
      return;
    }

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

    if (opts.json) {
      const config = loadConfig(rootDir, { userConfig: ctx.program.opts().userConfig });
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    } else {
      // Human-readable table: Key | Value | Source
      const { config, provenance } = loadConfigWithProvenance(rootDir, {
        userConfig: ctx.program.opts().userConfig,
      });
      process.stdout.write(
        renderConfigTable(config as unknown as Record<string, unknown>, provenance),
      );

      if (globalPath && !consent) {
        process.stderr.write(
          `\nℹ Global config found at ${globalPath} — not applied to this repo.\n` +
            `  Run \`codegraph config --enable-global\` to opt in, or\n` +
            `  \`codegraph config --disable-global\` to dismiss this notice.\n`,
        );
      }
    }
  },
};
