import type { Import } from '../../../types.js';

/**
 * Pairs each locally-bound name from an import statement with its original
 * (pre-rename) exported name — identical to the local name unless the
 * specifier renames a binding (`import { X as Y }`). Barrel tracing and
 * target-file symbol lookups must search using the *original* name — the
 * renamed local alias only exists in the importing file, not in the file
 * being imported from (#1730).
 *
 * Also reports, per name, whether it should be treated as type-only —
 * either because the whole statement is (`import type { X }`) or because
 * this specific specifier carries the inline modifier
 * (`import { type X }`, #1813).
 *
 * Shared by the full-build (`stages/build-edges.ts`) and incremental
 * (`incremental.ts`) pipelines so the rename-stripping logic can't drift
 * between them.
 */
export function importNamePairs(
  imp: Import,
): Array<{ local: string; original: string; typeOnly: boolean }> {
  const originalNameFor = new Map<string, string>();
  for (const r of imp.renamedImports ?? []) originalNameFor.set(r.local, r.imported);
  const typeOnlyNames = new Set(imp.typeOnlyNames ?? []);
  return imp.names.map((name) => {
    const local = name.replace(/^\*\s+as\s+/, '');
    return {
      local,
      original: originalNameFor.get(local) ?? local,
      typeOnly: imp.typeOnly === true || typeOnlyNames.has(local),
    };
  });
}
