/**
 * ESM loader hook that instruments function calls to capture dynamic call edges.
 *
 * Maintains a module-scoped call stack to track caller→callee relationships.
 * Patches module exports so that every function/method call is recorded as
 * a { caller, callee } edge with file information.
 *
 * Note: the call stack is a shared mutable array, so concurrent async call
 * chains may interleave. This is acceptable for the current sequential
 * benchmark driver but would need AsyncLocalStorage for parallel execution.
 *
 * Usage:
 *   node --import ./loader-hook.mjs driver.mjs
 *
 * After the driver finishes, call `globalThis.__tracer.dump()` to get edges.
 */

import { register } from 'node:module';
import path from 'node:path';

// Register the ESM load() hook that instruments fixture source code.
// The hooks module runs in a separate thread; it transforms source text
// to inject enter()/exit() calls that reference globalThis.__tracer (set up below).
register(new URL('./loader-hooks.mjs', import.meta.url).href);

/** @type {Array<{source_name: string, source_file: string, target_name: string, target_file: string}>} */
const edges = [];

/** @type {Map<string, string>} - maps "file::name" to canonical key */
const seen = new Set();

/** Current call stack: array of { name, file } */
let callStack = [];

function basename(filePath) {
  return path.basename(filePath).replace(/\?.*$/, '');
}

function recordEdge(callerName, callerFile, calleeName, calleeFile) {
  const key = `${callerName}@${basename(callerFile)}->${calleeName}@${basename(calleeFile)}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({
    source_name: callerName,
    source_file: basename(callerFile),
    target_name: calleeName,
    target_file: basename(calleeFile),
  });
}

/**
 * Wrap a function so that calls to it are recorded as edges.
 * @param {Function} fn - The original function
 * @param {string} name - The function/method name (e.g. "validate" or "UserService.createUser")
 * @param {string} file - The file path where this function is defined
 * @returns {Function} Wrapped function
 */
function wrapFunction(fn, name, file) {
  if (typeof fn !== 'function') return fn;
  if (fn.__traced) return fn;

  const wrapped = function (...args) {
    // Record edge from current caller to this function
    if (callStack.length > 0) {
      const caller = callStack[callStack.length - 1];
      recordEdge(caller.name, caller.file, name, file);
    }

    callStack.push({ name, file });
    try {
      const result = fn.apply(this, args);
      // Handle async functions
      if (result && typeof result.then === 'function') {
        return result.finally(() => {
          callStack.pop();
        });
      }
      callStack.pop();
      return result;
    } catch (e) {
      callStack.pop();
      throw e;
    }
  };

  wrapped.__traced = true;
  wrapped.__originalName = name;
  wrapped.__originalFile = file;
  // Preserve function properties
  Object.defineProperty(wrapped, 'name', { value: fn.name || name });
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  return wrapped;
}

/**
 * Wrap all methods on a class prototype.
 */
function wrapClassMethods(cls, className, file) {
  if (!cls?.prototype) return cls;
  const proto = cls.prototype;

  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (desc && typeof desc.value === 'function') {
      proto[key] = wrapFunction(desc.value, `${className}.${key}`, file);
    }
  }

  // Also wrap the constructor to track instantiation calls.
  // Must use Reflect.construct so the wrapper is a valid constructor target.
  const origConstructor = cls;
  function wrappedClass(...args) {
    if (callStack.length > 0) {
      const caller = callStack[callStack.length - 1];
      recordEdge(caller.name, caller.file, `${className}.constructor`, file);
    }
    callStack.push({ name: `${className}.constructor`, file });
    try {
      const instance = Reflect.construct(origConstructor, args, new.target || origConstructor);
      callStack.pop();
      return instance;
    } catch (e) {
      callStack.pop();
      throw e;
    }
  }
  wrappedClass.prototype = origConstructor.prototype;
  wrappedClass.__traced = true;
  Object.defineProperty(wrappedClass, 'name', { value: className });
  return wrappedClass;
}

/**
 * Instrument a module's exports.
 * @param {object} moduleExports - The module namespace object
 * @param {string} filePath - The file path of the module
 * @returns {object} Instrumented exports
 */
function instrumentExports(moduleExports, filePath) {
  const file = basename(filePath);
  const instrumented = {};

  for (const [key, value] of Object.entries(moduleExports)) {
    if (typeof value === 'function') {
      // Check if it's a class (has prototype with methods beyond constructor)
      const protoKeys = value.prototype
        ? Object.getOwnPropertyNames(value.prototype).filter((k) => k !== 'constructor')
        : [];
      if (protoKeys.length > 0 || /^[A-Z]/.test(key)) {
        // Treat as a class — use return value so constructor wrapping takes effect
        instrumented[key] = wrapClassMethods(value, key, file);
      } else {
        instrumented[key] = wrapFunction(value, key, file);
      }
    } else {
      instrumented[key] = value;
    }
  }

  return instrumented;
}

/**
 * Enter a function scope: record the call edge from the current top-of-stack
 * (the caller) to this function (the callee), then push onto the stack.
 * Used by the load() hook's source-level instrumentation.
 */
function enterFunction(name, file) {
  const f = basename(file);
  if (callStack.length > 0) {
    const caller = callStack[callStack.length - 1];
    recordEdge(caller.name, caller.file, name, f);
  }
  callStack.push({ name, file: f });
}

function exitFunction() {
  if (callStack.length > 0) callStack.pop();
}

// Expose the tracer globally so driver scripts can use it
globalThis.__tracer = {
  edges,
  wrapFunction,
  wrapClassMethods,
  instrumentExports,
  recordEdge,
  enter: enterFunction,
  exit: exitFunction,
  pushCall(name, file) {
    callStack.push({ name, file: basename(file) });
  },
  popCall() {
    callStack.pop();
  },
  dump() {
    return [...edges];
  },
  reset() {
    edges.length = 0;
    seen.clear();
    callStack = [];
  },
};

