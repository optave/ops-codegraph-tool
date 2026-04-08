import { isTestFile } from '../../infrastructure/test-filter.js';
import { CORE_SYMBOL_KINDS } from '../../shared/kinds.js';
import { normalizeSymbol, toSymbolRef } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import type { RelatedNodeRow } from '../../types.js';
import { withRepo } from './query-helpers.js';
import { findMatchingNodes } from './symbol-lookup.js';

/**
 * Find all concrete types implementing a given interface/trait.
 */
export function implementationsData(
  name: string,
  customDbPath: string,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
) {
  return withRepo(customDbPath, (repo) => {
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(repo, name, {
      noTests,
      file: opts.file,
      kind: opts.kind,
      kinds: opts.kind ? undefined : CORE_SYMBOL_KINDS,
    });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      let implementors = repo.findImplementors(node.id) as RelatedNodeRow[];
      if (noTests) implementors = implementors.filter((n) => !isTestFile(n.file));

      return {
        ...normalizeSymbol(node, repo, hc),
        implementors: implementors.map(toSymbolRef),
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  });
}

/**
 * Find all interfaces/traits that a given class/struct implements.
 */
export function interfacesData(
  name: string,
  customDbPath: string,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
) {
  return withRepo(customDbPath, (repo) => {
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(repo, name, {
      noTests,
      file: opts.file,
      kind: opts.kind,
      kinds: opts.kind ? undefined : CORE_SYMBOL_KINDS,
    });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      let interfaces = repo.findInterfaces(node.id) as RelatedNodeRow[];
      if (noTests) interfaces = interfaces.filter((n) => !isTestFile(n.file));

      return {
        ...normalizeSymbol(node, repo, hc),
        interfaces: interfaces.map(toSymbolRef),
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  });
}
