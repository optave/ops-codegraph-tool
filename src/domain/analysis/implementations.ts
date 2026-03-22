import { findImplementors, findInterfaces, openReadonlyOrFail } from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { CORE_SYMBOL_KINDS } from '../../shared/kinds.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import { findMatchingNodes } from './symbol-lookup.js';

/**
 * Find all concrete types implementing a given interface/trait.
 *
 * @param {string} name - Interface/trait name (partial match)
 * @param {string|undefined} customDbPath
 * @param {{ noTests?: boolean, file?: string, kind?: string, limit?: number, offset?: number }} opts
 * @returns {{ name: string, results: Array<{ name: string, kind: string, file: string, line: number, implementors: Array<{ name: string, kind: string, file: string, line: number }> }> }}
 */
export function implementationsData(
  name: string,
  customDbPath: string | undefined,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(db, name, {
      noTests,
      file: opts.file,
      kind: opts.kind,
      kinds: opts.kind ? undefined : [...CORE_SYMBOL_KINDS],
    });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
    const results = (nodes as any[]).map((node) => {
      let implementors = findImplementors(db, node.id);
      if (noTests) implementors = implementors.filter((n) => !isTestFile(n.file));

      return {
        ...normalizeSymbol(node, db, hc),
        implementors: implementors.map((impl) => ({
          name: impl.name,
          kind: impl.kind,
          file: impl.file,
          line: impl.line,
        })),
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

/**
 * Find all interfaces/traits that a given class/struct implements.
 *
 * @param {string} name - Class/struct name (partial match)
 * @param {string|undefined} customDbPath
 * @param {{ noTests?: boolean, file?: string, kind?: string, limit?: number, offset?: number }} opts
 * @returns Object with name and results array containing interface info
 */
export function interfacesData(
  name: string,
  customDbPath: string | undefined,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(db, name, {
      noTests,
      file: opts.file,
      kind: opts.kind,
      kinds: opts.kind ? undefined : [...CORE_SYMBOL_KINDS],
    });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
    const results = (nodes as any[]).map((node) => {
      let interfaces = findInterfaces(db, node.id);
      if (noTests) interfaces = interfaces.filter((n) => !isTestFile(n.file));

      return {
        ...normalizeSymbol(node, db, hc),
        interfaces: interfaces.map((iface) => ({
          name: iface.name,
          kind: iface.kind,
          file: iface.file,
          line: iface.line,
        })),
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
