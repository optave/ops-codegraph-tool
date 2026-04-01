import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractSoliditySymbols } from '../../src/domain/parser.js';

describe('Solidity parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseSol(code: string) {
    const parser = parsers.get('solidity');
    if (!parser) throw new Error('Solidity parser not available');
    const tree = parser.parse(code);
    return extractSoliditySymbols(tree, 'test.sol');
  }

  it('extracts contract declarations', () => {
    const symbols = parseSol(`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MyToken {
    uint256 public totalSupply;
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyToken', kind: 'class' }),
    );
  });

  it('extracts interface declarations', () => {
    const symbols = parseSol(`interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'IERC20', kind: 'interface' }),
    );
  });

  it('extracts function definitions', () => {
    const symbols = parseSol(`contract Token {
    function transfer(address to, uint256 amount) public returns (bool) {
        return true;
    }
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Token.transfer', kind: 'method' }),
    );
  });

  it('extracts import directives', () => {
    const symbols = parseSol(`import "./IERC20.sol";`);
    expect(symbols.imports).toContainEqual(expect.objectContaining({ source: './IERC20.sol' }));
  });

  it('extracts inheritance', () => {
    const symbols = parseSol(`contract MyToken is ERC20 {
}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'MyToken', extends: 'ERC20' }),
    );
  });
});
