/**
 * Unit tests for PipelineContext.
 */
import { describe, expect, it } from 'vitest';
import { PipelineContext } from '../../src/builder/context.js';

describe('PipelineContext', () => {
  it('creates an instance with default values', () => {
    const ctx = new PipelineContext();
    expect(ctx.earlyExit).toBe(false);
    expect(ctx.forceFullRebuild).toBe(false);
    expect(ctx.hasEmbeddings).toBe(false);
    expect(ctx.timing).toEqual({});
  });

  it('allows setting all stage fields', () => {
    const ctx = new PipelineContext();
    ctx.rootDir = '/tmp/test';
    ctx.allFiles = ['/tmp/test/a.js'];
    ctx.parseChanges = [];
    ctx.allSymbols = new Map();
    ctx.fileSymbols = new Map();
    ctx.reexportMap = new Map();
    ctx.barrelOnlyFiles = new Set();
    ctx.nodesByName = new Map();
    ctx.nodesByNameAndFile = new Map();

    expect(ctx.rootDir).toBe('/tmp/test');
    expect(ctx.allFiles).toHaveLength(1);
    expect(ctx.parseChanges).toHaveLength(0);
    expect(ctx.allSymbols).toBeInstanceOf(Map);
    expect(ctx.fileSymbols).toBeInstanceOf(Map);
  });

  it('timing accumulates across stages', () => {
    const ctx = new PipelineContext();
    ctx.timing.parseMs = 10;
    ctx.timing.insertMs = 20;
    ctx.timing.edgesMs = 30;
    expect(ctx.timing).toEqual({ parseMs: 10, insertMs: 20, edgesMs: 30 });
  });
});
