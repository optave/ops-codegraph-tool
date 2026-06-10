// Regression guard: bare function calls in JS class methods must NOT resolve
// to same-named class methods. In JS/TS, bare foo() is lexically scoped to
// the module, not the class — there is no implicit this binding on bare calls.
//
// If the call.receiver guard in resolveByMethodOrGlobal (call-resolver.ts) is
// ever removed, the resolver would incorrectly emit Processor.run → Processor.flush
// (a false positive). The 1.0 precision floor on the JS fixture catches that
// regression immediately.

export function processData(x) {
  return x * 2;
}

export class Processor {
  run(x) {
    processData(x); // same-file module-level function — resolves correctly
    flush(); // bare call; no module-level 'flush' in scope — must NOT resolve to Processor.flush
  }

  flush() {} // Processor.flush exists; bare flush() in run() must not target it
}
