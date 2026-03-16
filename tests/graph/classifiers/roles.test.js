import { describe, expect, it } from 'vitest';
import { classifyRoles } from '../../../src/graph/classifiers/roles.js';

describe('classifyRoles', () => {
  it('returns empty map for empty input', () => {
    expect(classifyRoles([]).size).toBe(0);
  });

  it('classifies dead nodes (no fan-in, not exported)', () => {
    const nodes = [{ id: '1', name: 'unused', fanIn: 0, fanOut: 0, isExported: false }];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead');
  });

  it('classifies entry nodes (no fan-in, exported)', () => {
    const nodes = [{ id: '1', name: 'init', fanIn: 0, fanOut: 3, isExported: true }];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('entry');
  });

  it('classifies framework entry via prefix', () => {
    const nodes = [{ id: '1', name: 'route:/api/users', fanIn: 5, fanOut: 5, isExported: false }];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('entry');
  });

  it('classifies core (high fan-in, low fan-out)', () => {
    // Need multiple nodes so median can be computed
    const nodes = [
      { id: '1', name: 'coreLib', fanIn: 10, fanOut: 0, isExported: true },
      { id: '2', name: 'caller', fanIn: 0, fanOut: 10, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('core');
  });

  it('classifies utility (high fan-in AND high fan-out)', () => {
    const nodes = [
      { id: '1', name: 'hub', fanIn: 10, fanOut: 10, isExported: true },
      { id: '2', name: 'other', fanIn: 1, fanOut: 1, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('utility');
  });

  it('classifies adapter (low fan-in, high fan-out)', () => {
    const nodes = [
      { id: '1', name: 'adapter', fanIn: 1, fanOut: 10, isExported: true },
      { id: '2', name: 'dep', fanIn: 10, fanOut: 0, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('adapter');
  });

  it('classifies leaf (low everything)', () => {
    const nodes = [
      { id: '1', name: 'leaf', fanIn: 1, fanOut: 0, isExported: false },
      { id: '2', name: 'hub', fanIn: 10, fanOut: 10, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });
});
