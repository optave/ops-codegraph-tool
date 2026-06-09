/**
 * Unit tests for resolveByMethodOrGlobal in call-resolver.ts.
 *
 * Covers the qualified callerName fix (#1385): when callerName has more than
 * one dot segment (e.g. 'Namespace.ClassName.method'), the same-class dispatch
 * must use only the segment immediately before the method name ('ClassName'),
 * not the full qualified prefix ('Namespace.ClassName').
 */
import { describe, expect, it } from 'vitest';
import type { CallNodeLookup } from '../../src/domain/graph/builder/call-resolver.js';
import { resolveByMethodOrGlobal } from '../../src/domain/graph/builder/call-resolver.js';

function makeLookup(
  methodMap: Record<string, Array<{ id: number; file: string; kind: string }>>,
): CallNodeLookup {
  return {
    byName(name) {
      return methodMap[name] ?? [];
    },
    byNameAndFile() {
      return [];
    },
    isBarrel() {
      return false;
    },
    resolveBarrel() {
      return null;
    },
    nodeId() {
      return undefined;
    },
  };
}

describe('resolveByMethodOrGlobal — same-class this-dispatch with qualified callerName (#1385)', () => {
  const method = { id: 42, file: 'shapes.js', kind: 'method' };

  it('resolves this.area() inside ClassName.describe using bare ClassName', () => {
    const lookup = makeLookup({ 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Shape.describe',
    );
    expect(result).toEqual([method]);
  });

  it('resolves this.area() inside Namespace.ClassName.describe using bare ClassName only', () => {
    // Symbols are stored as 'Shape.area', not 'Namespace.Shape.area'.
    // Before the fix, callerClass was 'Namespace.Shape' → lookup failed.
    const lookup = makeLookup({ 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Namespace.Shape.describe',
    );
    expect(result).toEqual([method]);
  });

  it('does not resolve when callerName has no dot (bare function)', () => {
    const lookup = makeLookup({ 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'describe',
    );
    // No dot → no class prefix → falls through to exact bare-name lookup
    expect(result).toEqual([]);
  });

  it('does not match namespace-qualified DB key when callerName has multiple dots', () => {
    // Only a wrong key exists in the DB; the correct lookup should not find it.
    const lookup = makeLookup({ 'Namespace.Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Namespace.Shape.describe',
    );
    // callerClass should be 'Shape', so 'Shape.area' is tried — which is absent.
    expect(result).toEqual([]);
  });
});
