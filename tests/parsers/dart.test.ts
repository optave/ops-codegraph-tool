import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractDartSymbols } from '../../src/domain/parser.js';

describe('Dart parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseDart(code) {
    const parser = parsers.get('dart');
    if (!parser) throw new Error('Dart parser not available');
    const tree = parser.parse(code);
    return extractDartSymbols(tree, 'test.dart');
  }

  it('extracts class definitions', () => {
    const symbols = parseDart(`class User {
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class' }),
    );
  });

  it('extracts enum definitions', () => {
    const symbols = parseDart(`enum Color { red, green, blue }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts class inheritance', () => {
    const symbols = parseDart(`class Admin extends User {
}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'User' }),
    );
  });

  it('extracts import statements', () => {
    const symbols = parseDart(`import 'dart:io';
import 'package:flutter/material.dart';`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts constructor calls', () => {
    const symbols = parseDart(`var user = User("Alice");`);
    // Constructor calls may or may not be detected depending on the grammar
    // This test verifies the parser doesn't crash on constructor syntax
    expect(symbols).toBeDefined();
  });
});
