// Combined specifier list: one plain re-export (loadPlotConfig) and one
// renamed re-export (buildLayoutOptions -> buildOptions) in a single
// statement, alongside a type-only import that must NOT be treated as a
// reexport. Two own definitions keep this file from being (mis)classified
// as barrel-only (own-def count > reexport-statement count) — an unrelated,
// separately-tracked engine divergence (#1848) that would otherwise drop
// the type-only import's edges on native full builds.
export { buildLayoutOptions as buildOptions, loadPlotConfig } from './viewer.js';

import type { PlotConfig } from './viewer.js';

export function useConfig(): PlotConfig {
  return { width: 1 };
}

export function noop(): void {}
