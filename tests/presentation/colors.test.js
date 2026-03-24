/**
 * Unit tests for presentation/colors.ts — color constant validation.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_COLORS,
  DEFAULT_NODE_COLORS,
  DEFAULT_ROLE_COLORS,
} from '../../src/presentation/colors.js';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

describe('DEFAULT_NODE_COLORS', () => {
  const expectedKinds = [
    'function',
    'method',
    'class',
    'interface',
    'type',
    'struct',
    'enum',
    'trait',
    'record',
    'module',
    'file',
    'parameter',
    'property',
    'constant',
  ];

  it('has a color for every node kind', () => {
    for (const kind of expectedKinds) {
      expect(DEFAULT_NODE_COLORS).toHaveProperty(kind);
    }
  });

  it('all values are valid hex colors', () => {
    for (const [kind, color] of Object.entries(DEFAULT_NODE_COLORS)) {
      expect(color, `${kind} color`).toMatch(HEX_COLOR);
    }
  });
});

describe('DEFAULT_ROLE_COLORS', () => {
  const expectedRoles = ['entry', 'core', 'utility', 'dead', 'leaf'];

  it('has a color for expected roles', () => {
    for (const role of expectedRoles) {
      expect(DEFAULT_ROLE_COLORS).toHaveProperty(role);
    }
  });

  it('all values are valid hex colors', () => {
    for (const [role, color] of Object.entries(DEFAULT_ROLE_COLORS)) {
      expect(color, `${role} color`).toMatch(HEX_COLOR);
    }
  });
});

describe('COMMUNITY_COLORS', () => {
  it('has exactly 12 colors', () => {
    expect(COMMUNITY_COLORS).toHaveLength(12);
  });

  it('all values are valid hex colors', () => {
    for (const color of COMMUNITY_COLORS) {
      expect(color).toMatch(HEX_COLOR);
    }
  });

  it('all colors are unique', () => {
    const unique = new Set(COMMUNITY_COLORS);
    expect(unique.size).toBe(COMMUNITY_COLORS.length);
  });
});
