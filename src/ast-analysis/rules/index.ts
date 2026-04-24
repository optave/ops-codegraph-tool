import type {
  CfgRulesConfig,
  ComplexityRules,
  DataflowRulesConfig,
  HalsteadRules,
} from '../../types.js';
import * as csharp from './csharp.js';
import * as go from './go.js';
import * as java from './java.js';
import * as javascript from './javascript.js';
import * as php from './php.js';
import * as python from './python.js';
import * as ruby from './ruby.js';
import * as rust from './rust.js';

// ─── Complexity Rules ─────────────────────────────────────────────────────

export const COMPLEXITY_RULES: Map<string, ComplexityRules> = new Map([
  ['javascript', javascript.complexity],
  ['typescript', javascript.complexity],
  ['tsx', javascript.complexity],
  ['python', python.complexity],
  ['go', go.complexity],
  ['rust', rust.complexity],
  ['java', java.complexity],
  ['csharp', csharp.complexity],
  ['ruby', ruby.complexity],
  ['php', php.complexity],
]);

// ─── Halstead Rules ───────────────────────────────────────────────────────

export const HALSTEAD_RULES: Map<string, HalsteadRules> = new Map([
  ['javascript', javascript.halstead],
  ['typescript', javascript.halstead],
  ['tsx', javascript.halstead],
  ['python', python.halstead],
  ['go', go.halstead],
  ['rust', rust.halstead],
  ['java', java.halstead],
  ['csharp', csharp.halstead],
  ['ruby', ruby.halstead],
  ['php', php.halstead],
]);

// ─── CFG Rules ────────────────────────────────────────────────────────────

export const CFG_RULES: Map<string, CfgRulesConfig> = new Map([
  ['javascript', javascript.cfg],
  ['typescript', javascript.cfg],
  ['tsx', javascript.cfg],
  ['python', python.cfg],
  ['go', go.cfg],
  ['rust', rust.cfg],
  ['java', java.cfg],
  ['csharp', csharp.cfg],
  ['ruby', ruby.cfg],
  ['php', php.cfg],
]);

// ─── Dataflow Rules ──────────────────────────────────────────────────────

export const DATAFLOW_RULES: Map<string, DataflowRulesConfig> = new Map([
  ['javascript', javascript.dataflow],
  ['typescript', javascript.dataflow],
  ['tsx', javascript.dataflow],
  ['python', python.dataflow],
  ['go', go.dataflow],
  ['rust', rust.dataflow],
  ['java', java.dataflow],
  ['csharp', csharp.dataflow],
  ['php', php.dataflow],
  ['ruby', ruby.dataflow],
]);

// ─── AST Node Type Maps ──────────────────────────────────────────────────
//
// These mirror the per-language `LangAstConfig` constants in the native Rust
// engine (`crates/codegraph-core/src/extractors/helpers.rs`). WASM and native
// must agree on which tree-sitter node types to emit as `ast_nodes` rows.
// Languages without a dedicated rules/*.ts file have their maps inlined here.

const JS_AST_TYPES = javascript.astTypes as Record<string, string>;
const PY_AST_TYPES = python.astTypes as Record<string, string>;
const GO_AST_TYPES = go.astTypes as Record<string, string>;
const RS_AST_TYPES = rust.astTypes as Record<string, string>;
const JAVA_AST_TYPES = java.astTypes as Record<string, string>;
const CS_AST_TYPES = csharp.astTypes as Record<string, string>;
const RB_AST_TYPES = ruby.astTypes as Record<string, string>;
const PHP_AST_TYPES = php.astTypes as Record<string, string>;

const C_AST_TYPES: Record<string, string> = {
  string_literal: 'string',
};

const CPP_AST_TYPES: Record<string, string> = {
  new_expression: 'new',
  throw_statement: 'throw',
  co_await_expression: 'await',
  string_literal: 'string',
  raw_string_literal: 'string',
};

const KOTLIN_AST_TYPES: Record<string, string> = {
  throw_expression: 'throw',
  string_literal: 'string',
};

const SWIFT_AST_TYPES: Record<string, string> = {
  throw_statement: 'throw',
  await_expression: 'await',
  string_literal: 'string',
};

const SCALA_AST_TYPES: Record<string, string> = {
  object_creation_expression: 'new',
  throw_expression: 'throw',
  string_literal: 'string',
};

const BASH_AST_TYPES: Record<string, string> = {
  string: 'string',
  expansion: 'string',
};

const ELIXIR_AST_TYPES: Record<string, string> = {
  string: 'string',
  sigil: 'regex',
};

const LUA_AST_TYPES: Record<string, string> = {
  string: 'string',
};

const DART_AST_TYPES: Record<string, string> = {
  new_expression: 'new',
  constructor_invocation: 'new',
  throw_expression: 'throw',
  await_expression: 'await',
  string_literal: 'string',
};

const ZIG_AST_TYPES: Record<string, string> = {
  string_literal: 'string',
};

const HASKELL_AST_TYPES: Record<string, string> = {
  string: 'string',
  char: 'string',
};

const OCAML_AST_TYPES: Record<string, string> = {
  string: 'string',
};

export const AST_TYPE_MAPS: Map<string, Record<string, string>> = new Map([
  ['javascript', JS_AST_TYPES],
  ['typescript', JS_AST_TYPES],
  ['tsx', JS_AST_TYPES],
  ['python', PY_AST_TYPES],
  ['go', GO_AST_TYPES],
  ['rust', RS_AST_TYPES],
  ['java', JAVA_AST_TYPES],
  ['csharp', CS_AST_TYPES],
  ['ruby', RB_AST_TYPES],
  ['php', PHP_AST_TYPES],
  ['c', C_AST_TYPES],
  ['cpp', CPP_AST_TYPES],
  ['kotlin', KOTLIN_AST_TYPES],
  ['swift', SWIFT_AST_TYPES],
  ['scala', SCALA_AST_TYPES],
  ['bash', BASH_AST_TYPES],
  ['elixir', ELIXIR_AST_TYPES],
  ['lua', LUA_AST_TYPES],
  ['dart', DART_AST_TYPES],
  ['zig', ZIG_AST_TYPES],
  ['haskell', HASKELL_AST_TYPES],
  ['ocaml', OCAML_AST_TYPES],
  ['ocaml-interface', OCAML_AST_TYPES],
]);

// ─── Per-language string-extraction config ───────────────────────────────
//
// Mirrors `quote_chars` + `string_prefixes` in the native `LangAstConfig`.
// Used by the AST-store visitor to strip quote characters and language-
// specific prefix sigils (Python `r"..."`, C# verbatim `@"..."`, Rust raw
// `r#"..."#`, etc.) when computing string content for the `name` column.

export interface AstStringConfig {
  quoteChars: string;
  stringPrefixes: string;
}

const JS_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"`', stringPrefixes: '' };
const PY_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"', stringPrefixes: 'rbfuRBFU' };
const GO_STRING_CONFIG: AstStringConfig = { quoteChars: '"`', stringPrefixes: '' };
const RS_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const JAVA_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const CS_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const RB_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"', stringPrefixes: '' };
const PHP_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"', stringPrefixes: '' };
const C_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const CPP_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: 'LuUR' };
const KOTLIN_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const SWIFT_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const SCALA_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const BASH_STRING_CONFIG: AstStringConfig = { quoteChars: '"\'', stringPrefixes: '' };
const ELIXIR_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const LUA_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"', stringPrefixes: '' };
const DART_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"', stringPrefixes: '' };
const ZIG_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };
const HASKELL_STRING_CONFIG: AstStringConfig = { quoteChars: '"\'', stringPrefixes: '' };
const OCAML_STRING_CONFIG: AstStringConfig = { quoteChars: '"', stringPrefixes: '' };

export const AST_STRING_CONFIGS: Map<string, AstStringConfig> = new Map([
  ['javascript', JS_STRING_CONFIG],
  ['typescript', JS_STRING_CONFIG],
  ['tsx', JS_STRING_CONFIG],
  ['python', PY_STRING_CONFIG],
  ['go', GO_STRING_CONFIG],
  ['rust', RS_STRING_CONFIG],
  ['java', JAVA_STRING_CONFIG],
  ['csharp', CS_STRING_CONFIG],
  ['ruby', RB_STRING_CONFIG],
  ['php', PHP_STRING_CONFIG],
  ['c', C_STRING_CONFIG],
  ['cpp', CPP_STRING_CONFIG],
  ['kotlin', KOTLIN_STRING_CONFIG],
  ['swift', SWIFT_STRING_CONFIG],
  ['scala', SCALA_STRING_CONFIG],
  ['bash', BASH_STRING_CONFIG],
  ['elixir', ELIXIR_STRING_CONFIG],
  ['lua', LUA_STRING_CONFIG],
  ['dart', DART_STRING_CONFIG],
  ['zig', ZIG_STRING_CONFIG],
  ['haskell', HASKELL_STRING_CONFIG],
  ['ocaml', OCAML_STRING_CONFIG],
  ['ocaml-interface', OCAML_STRING_CONFIG],
]);

// ─── Per-language "stop-after-collect" kinds ─────────────────────────────
//
// Mirrors the subtle difference between the native JS walker
// (`extractors/javascript.rs::walk_ast_nodes_depth`) — which *returns* after
// collecting `new_expression` and `throw_statement` to avoid double-counting
// the wrapped expression — and the generic walker (`helpers.rs::walk_ast_
// nodes_with_config_depth`), which always recurses. For WASM/native parity
// the JS family must skip recursion on `new` and `throw`; every other
// language recurses normally.

const JS_STOP_RECURSE: ReadonlySet<string> = new Set(['new', 'throw']);
const EMPTY_STOP_RECURSE: ReadonlySet<string> = new Set();

export function astStopRecurseKinds(langId: string): ReadonlySet<string> {
  if (langId === 'javascript' || langId === 'typescript' || langId === 'tsx') {
    return JS_STOP_RECURSE;
  }
  return EMPTY_STOP_RECURSE;
}
