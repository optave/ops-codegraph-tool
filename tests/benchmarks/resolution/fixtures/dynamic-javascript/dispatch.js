// Fixture: computed property dispatch patterns
// Resolvable: obj["method"]() — computed-literal kind
// Flagged:    obj[key]()      — computed-key kind (sink edge, not in expected-edges)

export function greet(name) {
  return `Hello, ${name}`;
}

export function farewell(name) {
  return `Goodbye, ${name}`;
}

export function runComputedLiteral(obj) {
  // obj["greet"]() — computed-literal: resolvable to greet()
  return obj['greet']('world');
}

export function runComputedKey(handlers, key) {
  // handlers[key]() — computed-key: flagged as sink edge
  return handlers[key]('world');
}
