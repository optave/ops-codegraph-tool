import { debug } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import type { BetterSqlite3Database } from '../types.js';

// ─── Glob-to-Regex ───────────────────────────────────────────────────

export function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

// ─── Presets ─────────────────────────────────────────────────────────

interface PresetDef {
  layers: string[];
  description: string;
}

export const PRESETS: Record<string, PresetDef> = {
  hexagonal: {
    layers: ['domain', 'application', 'adapters', 'infrastructure'],
    description: 'Inner layers cannot import outer layers',
  },
  layered: {
    layers: ['data', 'business', 'presentation'],
    description: 'Inward-only dependency direction',
  },
  clean: {
    layers: ['entities', 'usecases', 'interfaces', 'frameworks'],
    description: 'Inward-only dependency direction',
  },
  onion: {
    layers: ['domain-model', 'domain-services', 'application', 'infrastructure'],
    description: 'Inward-only dependency direction',
  },
};

// ─── Module Resolution ───────────────────────────────────────────────

interface ResolvedModule {
  regex: RegExp;
  pattern: string;
  layer?: string;
}

interface ModuleDef {
  match: string;
  layer?: string;
}

interface BoundaryRule {
  from: string;
  notTo?: string[];
  onlyTo?: string[];
  message?: string;
}

interface BoundaryConfig {
  modules?: Record<string, string | ModuleDef>;
  preset?: string;
  rules?: BoundaryRule[];
}

export function resolveModules(
  boundaryConfig: BoundaryConfig | undefined,
): Map<string, ResolvedModule> {
  const modules = new Map<string, ResolvedModule>();
  const defs = boundaryConfig?.modules;
  if (!defs || typeof defs !== 'object') return modules;

  for (const [name, value] of Object.entries(defs)) {
    if (typeof value === 'string') {
      modules.set(name, { regex: globToRegex(value), pattern: value });
    } else if (value && typeof value === 'object' && value.match) {
      modules.set(name, {
        regex: globToRegex(value.match),
        pattern: value.match,
        ...(value.layer ? { layer: value.layer } : {}),
      });
    }
  }
  return modules;
}

// ─── Validation ──────────────────────────────────────────────────────

function validateModules(modules: unknown, errors: string[]): void {
  if (!modules || typeof modules !== 'object' || Object.keys(modules as object).length === 0) {
    errors.push('boundaries.modules must be a non-empty object');
    return;
  }
  for (const [name, value] of Object.entries(modules as Record<string, unknown>)) {
    if (typeof value === 'string') continue;
    if (value && typeof value === 'object' && typeof (value as ModuleDef).match === 'string')
      continue;
    errors.push(`boundaries.modules.${name}: must be a glob string or { match: "<glob>" }`);
  }
}

function validatePreset(preset: unknown, errors: string[]): void {
  if (preset == null) return;
  if (typeof preset !== 'string' || !PRESETS[preset]) {
    errors.push(
      `boundaries.preset: must be one of ${Object.keys(PRESETS).join(', ')} (got "${preset}")`,
    );
  }
}

function validateTargetList(
  list: unknown,
  field: string,
  idx: number,
  moduleNames: Set<string>,
  errors: string[],
): void {
  if (!Array.isArray(list)) {
    errors.push(`boundaries.rules[${idx}]: "${field}" must be an array`);
    return;
  }
  for (const target of list) {
    if (!moduleNames.has(target)) {
      errors.push(`boundaries.rules[${idx}]: "${field}" references unknown module "${target}"`);
    }
  }
}

function validateRules(rules: unknown, modules: unknown, errors: string[]): void {
  if (!rules) return;
  if (!Array.isArray(rules)) {
    errors.push('boundaries.rules must be an array');
    return;
  }
  const moduleNames = modules ? new Set(Object.keys(modules as object)) : new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as BoundaryRule;
    if (!rule.from) {
      errors.push(`boundaries.rules[${i}]: missing "from" field`);
    } else if (!moduleNames.has(rule.from)) {
      errors.push(`boundaries.rules[${i}]: "from" references unknown module "${rule.from}"`);
    }
    if (rule.notTo && rule.onlyTo) {
      errors.push(`boundaries.rules[${i}]: cannot have both "notTo" and "onlyTo"`);
    }
    if (!rule.notTo && !rule.onlyTo) {
      errors.push(`boundaries.rules[${i}]: must have either "notTo" or "onlyTo"`);
    }
    if (rule.notTo) validateTargetList(rule.notTo, 'notTo', i, moduleNames, errors);
    if (rule.onlyTo) validateTargetList(rule.onlyTo, 'onlyTo', i, moduleNames, errors);
  }
}

function validateLayerAssignments(config: BoundaryConfig, errors: string[]): void {
  if (!config.preset || !PRESETS[config.preset] || !config.modules) return;
  const preset = PRESETS[config.preset]!;
  const presetLayers = new Set(preset.layers);
  for (const [name, value] of Object.entries(config.modules)) {
    if (typeof value === 'object' && value.layer && !presetLayers.has(value.layer)) {
      errors.push(
        `boundaries.modules.${name}: layer "${value.layer}" not in preset "${config.preset}" (valid: ${[...presetLayers].join(', ')})`,
      );
    }
  }
}

export function validateBoundaryConfig(config: unknown): { valid: boolean; errors: string[] } {
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['boundaries config must be an object'] };
  }

  const errors: string[] = [];
  const cfg = config as BoundaryConfig;
  validateModules(cfg.modules, errors);
  validatePreset(cfg.preset, errors);
  validateRules(cfg.rules, cfg.modules, errors);
  validateLayerAssignments(cfg, errors);
  return { valid: errors.length === 0, errors };
}

// ─── Preset Rule Generation ─────────────────────────────────────────

function generatePresetRules(
  modules: Map<string, ResolvedModule>,
  presetName: string,
): BoundaryRule[] {
  const preset = PRESETS[presetName];
  if (!preset) return [];

  const layers = preset.layers;
  const layerIndex = new Map<string, number>(layers.map((l, i) => [l, i]));

  const modulesByLayer = new Map<string, string[]>();
  for (const [name, mod] of modules) {
    if (mod.layer && layerIndex.has(mod.layer)) {
      if (!modulesByLayer.has(mod.layer)) modulesByLayer.set(mod.layer, []);
      modulesByLayer.get(mod.layer)!.push(name);
    }
  }

  const rules: BoundaryRule[] = [];
  for (const [layer, modNames] of modulesByLayer) {
    const idx = layerIndex.get(layer)!;
    const outerModules: string[] = [];
    for (const [otherLayer, otherModNames] of modulesByLayer) {
      if (layerIndex.get(otherLayer)! > idx) {
        outerModules.push(...otherModNames);
      }
    }
    if (outerModules.length > 0) {
      for (const from of modNames) {
        rules.push({ from, notTo: outerModules });
      }
    }
  }

  return rules;
}

// ─── Evaluation ──────────────────────────────────────────────────────

function classifyFile(filePath: string, modules: Map<string, ResolvedModule>): string | null {
  for (const [name, mod] of modules) {
    if (mod.regex.test(filePath)) return name;
  }
  return null;
}

interface BoundaryViolation {
  rule: string;
  name: string;
  file: string;
  targetFile: string;
  message: string;
  value: number;
  threshold: number;
}

interface EvaluateBoundariesOpts {
  scopeFiles?: string[];
  noTests?: boolean;
}

export function evaluateBoundaries(
  db: BetterSqlite3Database,
  boundaryConfig: BoundaryConfig | undefined,
  opts: EvaluateBoundariesOpts = {},
): { violations: BoundaryViolation[]; violationCount: number } {
  if (!boundaryConfig) return { violations: [], violationCount: 0 };

  const { valid, errors } = validateBoundaryConfig(boundaryConfig);
  if (!valid) {
    debug(`boundary config validation failed: ${errors.join('; ')}`);
    return { violations: [], violationCount: 0 };
  }

  const modules = resolveModules(boundaryConfig);
  if (modules.size === 0) return { violations: [], violationCount: 0 };

  let allRules: BoundaryRule[] = [];
  if (boundaryConfig.preset) {
    allRules = generatePresetRules(modules, boundaryConfig.preset);
  }
  if (boundaryConfig.rules && Array.isArray(boundaryConfig.rules)) {
    allRules = allRules.concat(boundaryConfig.rules);
  }
  if (allRules.length === 0) return { violations: [], violationCount: 0 };

  let edges: Array<{ source: string; target: string }>;
  try {
    edges = db
      .prepare(
        `SELECT DISTINCT n1.file AS source, n2.file AS target
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type')`,
      )
      .all() as Array<{ source: string; target: string }>;
  } catch (err) {
    debug(`boundary edge query failed: ${(err as Error).message}`);
    return { violations: [], violationCount: 0 };
  }

  if (opts.noTests) {
    edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
  }
  if (opts.scopeFiles) {
    const scope = new Set(opts.scopeFiles);
    edges = edges.filter((e) => scope.has(e.source));
  }

  const violations: BoundaryViolation[] = [];

  for (const edge of edges) {
    const fromModule = classifyFile(edge.source, modules);
    const toModule = classifyFile(edge.target, modules);

    if (!fromModule || !toModule) continue;

    for (const rule of allRules) {
      if (rule.from !== fromModule) continue;

      let isViolation = false;

      if (rule.notTo?.includes(toModule)) {
        isViolation = true;
      } else if (rule.onlyTo && !rule.onlyTo.includes(toModule)) {
        isViolation = true;
      }

      if (isViolation) {
        violations.push({
          rule: 'boundaries',
          name: `${fromModule} -> ${toModule}`,
          file: edge.source,
          targetFile: edge.target,
          message: rule.message || `${fromModule} must not depend on ${toModule}`,
          value: 1,
          threshold: 0,
        });
      }
    }
  }

  return { violations, violationCount: violations.length };
}
