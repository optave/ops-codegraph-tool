// Patterns for Function.prototype.bind / .call / .apply resolution.

function greet(greeting) {
  return `${greeting} ${this.name}`;
}

var user = { name: 'Alice' };

// bind: var f = fn.bind(ctx) — f() should resolve to fn()
var greetUser = greet.bind(user);

export function runBind() {
  return greetUser('Hello');
}

// call: fn.call(ctx, args) — resolved as a direct call to fn
export function runCall() {
  return greet.call(user, 'Hi');
}

// apply: fn.apply(ctx, argsArray) — resolved as a direct call to fn
export function runApply() {
  return greet.apply(user, ['Hey']);
}

// call with this as a callable: fn.call(namedFn, args) where namedFn is the 'this' context.
// Inside invoker, calling this(x) should resolve to the function passed as ctx.
function invoker(x) {
  return this(x);
}

function handler(n) {
  return n * 2;
}

export function runCallThis() {
  return invoker.call(handler, 10);
}
