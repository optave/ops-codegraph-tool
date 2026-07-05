/**
 * ESM hooks module — registered by loader-hook.mjs via node:module register().
 *
 * Runs in the hooks thread. Rewrites fixture module source so that EVERY
 * function/method body is wrapped with enter()/exit() tracing. This captures
 * intra-module (same-file) call edges that instrumentExports() misses because
 * non-exported functions are invisible from outside the module.
 *
 * The injected code references globalThis.__tracer which lives in the main
 * thread — the hooks thread only transforms text, never calls __tracer directly.
 */

function basename(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return (parts.pop() || filePath).replace(/\?.*$/, '');
}

/** Keywords that look like function calls but aren't */
const NOT_FUNCTIONS = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'return',
  'new',
  'throw',
  'typeof',
  'delete',
  'void',
  'await',
  'yield',
  'import',
  'export',
]);

/** Matches a class declaration line; returns the class name or null. */
function matchClassDeclaration(trimmed) {
  const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
  return classMatch && trimmed.includes('{') ? classMatch[1] : null;
}

/** Matches `function NAME(`, `export function NAME(`, `async function NAME(`. */
function matchFunctionDeclaration(trimmed) {
  const funcDecl = trimmed.match(
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
  );
  return funcDecl ? funcDecl[1] : null;
}

/** Matches `const/let/var NAME = async? (function | arrow)`. */
function matchAssignedFunction(trimmed) {
  const assignedFunc = trimmed.match(
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\s*\w*\s*\(|[^=]*=>\s*\{)/,
  );
  return assignedFunc ? assignedFunc[1] : null;
}

/** Matches a class method/constructor/getter/setter declaration (only inside a class body). */
function matchClassMethod(trimmed, currentClass, braceDepth, classDepth) {
  if (!currentClass || braceDepth <= classDepth) return null;
  const methodDecl = trimmed.match(/^(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?#?(\w+)\s*\(/);
  if (!methodDecl || NOT_FUNCTIONS.has(methodDecl[1])) return null;
  const mname = methodDecl[1];
  return mname === 'constructor' ? `${currentClass}.constructor` : `${currentClass}.${mname}`;
}

/**
 * Detects the function/method name declared on this line, if any.
 * Tries each pattern in order and returns the first match.
 */
function detectFunctionName(trimmed, currentClass, braceDepth, classDepth) {
  return (
    matchFunctionDeclaration(trimmed) ||
    matchAssignedFunction(trimmed) ||
    matchClassMethod(trimmed, currentClass, braceDepth, classDepth)
  );
}

/** Pops and closes any function scopes whose body ends at this line's new brace depth. */
function closeFinishedScopes(funcStack, newDepth, indent, output) {
  while (funcStack.length > 0 && newDepth <= funcStack[funcStack.length - 1].openDepth) {
    funcStack.pop();
    output.push(`${indent}} finally { globalThis.__tracer?.exit(); }`);
  }
}

/** Opens a new traced scope (enter + try) if this line declares a function/method. */
function openScopeIfDeclared(funcName, trimmed, indent, file, braceDepth, funcStack, output) {
  if (!funcName || !trimmed.endsWith('{')) return;
  const inner = `${indent}  `;
  const escaped = funcName.replace(/'/g, "\\'");
  output.push(`${inner}globalThis.__tracer?.enter('${escaped}', '${file}');`);
  output.push(`${inner}try {`);
  funcStack.push({ name: funcName, openDepth: braceDepth });
}

/**
 * Instrument all function/method declarations in source code.
 * Injects enter()/try and finally/exit() around each function body.
 *
 * Handles: function declarations, export functions, async functions,
 * class methods, constructors, static methods, getters/setters.
 */
function instrumentSource(source, filename) {
  const file = basename(filename);
  const lines = source.split('\n');
  const output = [];

  let currentClass = null;
  let classDepth = -1;
  let braceDepth = 0;

  const funcStack = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.match(/^(\s*)/)[1];

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    const newDepth = braceDepth + openBraces - closeBraces;

    const classMatch = matchClassDeclaration(trimmed);
    if (classMatch) {
      currentClass = classMatch;
      classDepth = braceDepth;
    }

    const funcName = detectFunctionName(trimmed, currentClass, braceDepth, classDepth);

    closeFinishedScopes(funcStack, newDepth, indent, output);
    output.push(line);
    openScopeIfDeclared(funcName, trimmed, indent, file, braceDepth, funcStack, output);

    braceDepth = newDepth;

    if (currentClass && braceDepth <= classDepth) {
      currentClass = null;
      classDepth = -1;
    }
  }

  // Safety: if brace counting drifted (e.g. braces inside strings/templates),
  // the injected try/finally blocks are likely misplaced. Return the original
  // source unchanged to avoid producing invalid JavaScript.
  if (braceDepth !== 0) {
    return source;
  }

  return output.join('\n');
}

/** Files to never instrument */
const SKIP_FILES = new Set(['driver.mjs', 'loader-hook.mjs', 'loader-hooks.mjs']);

/**
 * ESM load() hook — intercepts module loading to instrument fixture sources.
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  if (!url.startsWith('file://')) return result;
  if (url.includes('node_modules')) return result;

  const filePath = new URL(url).pathname;
  const fileName = basename(filePath);

  if (SKIP_FILES.has(fileName)) return result;
  if (!/\.(js|mjs|ts|tsx)$/.test(fileName)) return result;

  let source;
  if (typeof result.source === 'string') {
    source = result.source;
  } else if (result.source instanceof ArrayBuffer || ArrayBuffer.isView(result.source)) {
    source = new TextDecoder().decode(result.source);
  } else {
    return result;
  }

  const transformed = instrumentSource(source, fileName);
  return {
    ...result,
    source: transformed,
    format: result.format || context.format || 'module',
  };
}
