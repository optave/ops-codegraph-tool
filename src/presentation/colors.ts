/**
 * Shared color constants for the graph viewer.
 *
 * These live in a standalone module so both the domain layer (src/viewer.js)
 * and the presentation layer (src/presentation/viewer.js) can import them
 * without creating a cross-layer dependency.
 */

import type { AnyNodeKind, CoreRole } from '../types.js';

export const DEFAULT_NODE_COLORS: Record<AnyNodeKind, string> = {
  function: '#4CAF50',
  method: '#66BB6A',
  class: '#2196F3',
  interface: '#42A5F5',
  type: '#7E57C2',
  struct: '#FF7043',
  enum: '#FFA726',
  trait: '#26A69A',
  record: '#EC407A',
  module: '#78909C',
  file: '#90A4AE',
  parameter: '#B0BEC5',
  property: '#B0BEC5',
  constant: '#B0BEC5',
};

export const DEFAULT_ROLE_COLORS: Partial<Record<CoreRole, string>> = {
  entry: '#e8f5e9',
  core: '#e3f2fd',
  utility: '#f5f5f5',
  dead: '#ffebee',
  leaf: '#fffde7',
};

export const COMMUNITY_COLORS: readonly string[] = [
  '#4CAF50',
  '#2196F3',
  '#FF9800',
  '#9C27B0',
  '#F44336',
  '#00BCD4',
  '#CDDC39',
  '#E91E63',
  '#3F51B5',
  '#FF5722',
  '#009688',
  '#795548',
];
