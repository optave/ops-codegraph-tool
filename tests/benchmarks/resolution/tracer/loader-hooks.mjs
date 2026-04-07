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
  'if', 'while', 'for', 'switch', 'catch', 'return', 'new', 'throw',
  'typeof', 'delete', 'void', 'await', 'yield', 'import', 'export',
]);

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

    // Detect class declarations
    const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
    if (classMatch && trimmed.includes('{')) {
      currentClass = classMatch[1];
      classDepth = braceDepth;
    }

    // Detect function/method declarations
    let funcName = null;

    // function NAME(, export function NAME(, async function NAME(
    const funcDecl = trimmed.match(
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    );
    if (funcDecl) funcName = funcDecl[1];

    // Class method (only inside a class body)
    if (!funcName && currentClass && braceDepth > classDepth) {
      const methodDecl = trimmed.match(
        /^(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?#?(\w+)\s*\(/,
      );
      if (methodDecl && !NOT_FUNCTIONS.has(methodDecl[1])) {
        const mname = methodDecl[1];
        funcName =
          mname === 'constructor'
            ? `${currentClass}.constructor`
            : `${currentClass}.${mname}`;
      }
    }

    // Insert finally blocks for closing function scopes
    while (
      funcStack.length > 0 &&
      newDepth <= funcStack[funcStack.length - 1].openDepth
    ) {
      funcStack.pop();
      output.push(`${indent}} finally { globalThis.__tracer?.exit(); }`);
    }

    output.push(line);

    // Insert enter/try for new function declarations
    if (funcName && trimmed.endsWith('{')) {
      const inner = indent + '  ';
      const escaped = funcName.replace(/'/g, "\\'");
      output.push(
        `${inner}globalThis.__tracer?.enter('${escaped}', '${file}');`,
      );
      output.push(`${inner}try {`);
      funcStack.push({ name: funcName, openDepth: braceDepth });
    }

    braceDepth = newDepth;

    if (currentClass && braceDepth <= classDepth) {
      currentClass = null;
      classDepth = -1;
    }
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
