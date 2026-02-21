import { describe, it, expect, beforeAll } from 'vitest';
import { createParsers, extractPHPSymbols } from '../../src/parser.js';

describe('PHP parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parsePHP(code) {
    const parser = parsers.phpParser;
    if (!parser) throw new Error('PHP parser not available');
    const tree = parser.parse(code);
    return extractPHPSymbols(tree, 'test.php');
  }

  it('extracts function declarations', () => {
    const symbols = parsePHP(`<?php function greet($name) { return "hello " . $name; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' })
    );
  });

  it('extracts class declarations', () => {
    const symbols = parsePHP(`<?php class User { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class' })
    );
  });

  it('extracts method declarations', () => {
    const symbols = parsePHP(`<?php class Foo {
  public function bar() {}
  private function baz($x) { return $x; }
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.bar', kind: 'method' })
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.baz', kind: 'method' })
    );
  });

  it('extracts interface declarations', () => {
    const symbols = parsePHP(`<?php interface Serializable {
  public function serialize();
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable', kind: 'interface' })
    );
  });

  it('extracts trait declarations', () => {
    const symbols = parsePHP(`<?php trait HasTimestamps {
  public function getCreatedAt() {}
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'HasTimestamps', kind: 'interface' })
    );
  });

  it('extracts extends relationship', () => {
    const symbols = parsePHP(`<?php class Admin extends User { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'User' })
    );
  });

  it('extracts implements relationship', () => {
    const symbols = parsePHP(`<?php class UserService implements Serializable { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'UserService', implements: 'Serializable' })
    );
  });

  it('extracts use (namespace) declarations', () => {
    const symbols = parsePHP(`<?php
use App\\Models\\User;
use Illuminate\\Support\\Facades\\DB;
class Foo {}`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ names: ['User'] })
    );
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ names: ['DB'] })
    );
  });

  it('extracts function calls', () => {
    const symbols = parsePHP(`<?php
function run() {
  array_map(fn($x) => $x * 2, [1, 2, 3]);
  doSomething();
}`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'array_map' })
    );
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'doSomething' })
    );
  });

  it('extracts method calls', () => {
    const symbols = parsePHP(`<?php class Foo {
  function run() {
    $this->doWork();
    $user->getName();
  }
}`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'doWork' })
    );
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'getName' })
    );
  });

  it('extracts object creation', () => {
    const symbols = parsePHP(`<?php $u = new User("Alice");`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'User' })
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parsePHP(`<?php enum Color { case Red; case Green; case Blue; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'class' })
    );
  });
});
