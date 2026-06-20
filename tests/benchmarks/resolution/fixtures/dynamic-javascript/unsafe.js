// Fixture: eval/new Function patterns — flagged, not in expected-edges
// These emit sink edges (confidence=0.0) visible via `codegraph roles --dynamic`

export function runEval(code) {
  // eval(code) — flagged as eval kind
  return eval(code);
}

export function runNewFunction(body) {
  // new Function(body) — flagged as eval kind
  const fn = new Function(body);
  return fn();
}
