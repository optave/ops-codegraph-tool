import { debug } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';

// ─── Glob-to-Regex ───────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `**` (any path segment), `*` (non-slash), `?` (single non-slash char).
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches any number of path segments
      re += '.*';
      i += 2;
      // Skip trailing slash after **
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      // * matches non-slash characters
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

/**
 * Built-in preset definitions.
 * Each defines layers ordered from innermost (most protected) to outermost.
 * Inner layers cannot import from outer layers.
 */
export const PRESETS = {
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

/**
 * Parse module definitions into a Map of name → { regex, pattern, layer? }.
 * Supports string shorthand and object form.
 * @param {object} boundaryConfig - The `manifesto.boundaries` config object
 * @returns {Map<string, { regex: RegExp, pattern: string, layer?: string }>}
 */
export function resolveModules(boundaryConfig) {
  const modules = new Map();
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

/**
 * Validate the `modules` section of a boundary config.
 * @param {object} modules
 * @param {string[]} errors - Mutated: push any validation errors
 */
function validateModules(modules, errors) {
  if (!modules || typeof modules !== 'object' || Object.keys(modules).length === 0) {
    errors.push('boundaries.modules must be a non-empty object');
    return;
  }
  for (const [name, value] of Object.entries(modules)) {
    if (typeof value === 'string') continue;
    if (value && typeof value === 'object' && typeof value.match === 'string') continue;
    errors.push(`boundaries.modules.${name}: must be a glob string or { match: "<glob>" }`);
  }
}

/**
 * Validate the `preset` field of a boundary config.
 * @param {string|null|undefined} preset
 * @param {string[]} errors - Mutated: push any validation errors
 */
function validatePreset(preset, errors) {
  if (preset == null) return;
  if (typeof preset !== 'string' || !PRESETS[preset]) {
    errors.push(
      `boundaries.preset: must be one of ${Object.keys(PRESETS).join(', ')} (got "${preset}")`,
    );
  }
}

/**
 * Validate a single rule's target list (`notTo` or `onlyTo`).
 * @param {*} list - The target list value
 * @param {string} field - "notTo" or "onlyTo"
 * @param {number} idx - Rule index for error messages
 * @param {Set<string>} moduleNames
 * @param {string[]} errors - Mutated
 */
function validateTargetList(list, field, idx, moduleNames, errors) {
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

/**
 * Validate the `rules` array of a boundary config.
 * @param {Array} rules
 * @param {object|undefined} modules - The modules config (for cross-referencing names)
 * @param {string[]} errors - Mutated
 */
function validateRules(rules, modules, errors) {
  if (!rules) return;
  if (!Array.isArray(rules)) {
    errors.push('boundaries.rules must be an array');
    return;
  }
  const moduleNames = modules ? new Set(Object.keys(modules)) : new Set();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
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

/**
 * Validate that module layer assignments match preset layers.
 * @param {object} config
 * @param {string[]} errors - Mutated
 */
function validateLayerAssignments(config, errors) {
  if (!config.preset || !PRESETS[config.preset] || !config.modules) return;
  const presetLayers = new Set(PRESETS[config.preset].layers);
  for (const [name, value] of Object.entries(config.modules)) {
    if (typeof value === 'object' && value.layer && !presetLayers.has(value.layer)) {
      errors.push(
        `boundaries.modules.${name}: layer "${value.layer}" not in preset "${config.preset}" (valid: ${[...presetLayers].join(', ')})`,
      );
    }
  }
}

/**
 * Validate a boundary configuration object.
 * @param {object} config - The `manifesto.boundaries` config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBoundaryConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['boundaries config must be an object'] };
  }

  const errors = [];
  validateModules(config.modules, errors);
  validatePreset(config.preset, errors);
  validateRules(config.rules, config.modules, errors);
  validateLayerAssignments(config, errors);
  return { valid: errors.length === 0, errors };
}

// ─── Preset Rule Generation ─────────────────────────────────────────

/**
 * Generate notTo rules from preset layer assignments.
 * Inner layers cannot import from outer layers.
 */
function generatePresetRules(modules, presetName) {
  const preset = PRESETS[presetName];
  if (!preset) return [];

  const layers = preset.layers;
  const layerIndex = new Map(layers.map((l, i) => [l, i]));

  // Group modules by layer
  const modulesByLayer = new Map();
  for (const [name, mod] of modules) {
    if (mod.layer && layerIndex.has(mod.layer)) {
      if (!modulesByLayer.has(mod.layer)) modulesByLayer.set(mod.layer, []);
      modulesByLayer.get(mod.layer).push(name);
    }
  }

  const rules = [];
  // For each layer, forbid imports to any outer (higher-index) layer
  for (const [layer, modNames] of modulesByLayer) {
    const idx = layerIndex.get(layer);
    const outerModules = [];
    for (const [otherLayer, otherModNames] of modulesByLayer) {
      if (layerIndex.get(otherLayer) > idx) {
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

/**
 * Classify a file path into a module name. Returns the first matching module or null.
 */
function classifyFile(filePath, modules) {
  for (const [name, mod] of modules) {
    if (mod.regex.test(filePath)) return name;
  }
  return null;
}

/**
 * Evaluate boundary rules against the dependency graph.
 *
 * @param {object} db - Open SQLite database (readonly)
 * @param {object} boundaryConfig - The `manifesto.boundaries` config
 * @param {object} [opts]
 * @param {string[]} [opts.scopeFiles] - Only check edges from these files (diff-impact mode)
 * @param {boolean} [opts.noTests] - Exclude test files
 * @returns {{ violations: object[], violationCount: number }}
 */
export function evaluateBoundaries(db, boundaryConfig, opts = {}) {
  if (!boundaryConfig) return { violations: [], violationCount: 0 };

  const { valid, errors } = validateBoundaryConfig(boundaryConfig);
  if (!valid) {
    debug('boundary config validation failed: %s', errors.join('; '));
    return { violations: [], violationCount: 0 };
  }

  const modules = resolveModules(boundaryConfig);
  if (modules.size === 0) return { violations: [], violationCount: 0 };

  // Merge user rules with preset-generated rules
  let allRules = [];
  if (boundaryConfig.preset) {
    allRules = generatePresetRules(modules, boundaryConfig.preset);
  }
  if (boundaryConfig.rules && Array.isArray(boundaryConfig.rules)) {
    allRules = allRules.concat(boundaryConfig.rules);
  }
  if (allRules.length === 0) return { violations: [], violationCount: 0 };

  // Query file-level import edges
  let edges;
  try {
    edges = db
      .prepare(
        `SELECT DISTINCT n1.file AS source, n2.file AS target
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type')`,
      )
      .all();
  } catch (err) {
    debug('boundary edge query failed: %s', err.message);
    return { violations: [], violationCount: 0 };
  }

  // Filter by scope and tests
  if (opts.noTests) {
    edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
  }
  if (opts.scopeFiles) {
    const scope = new Set(opts.scopeFiles);
    edges = edges.filter((e) => scope.has(e.source));
  }

  // Check each edge against rules
  const violations = [];

  for (const edge of edges) {
    const fromModule = classifyFile(edge.source, modules);
    const toModule = classifyFile(edge.target, modules);

    // Skip edges where source or target is not in any module
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
