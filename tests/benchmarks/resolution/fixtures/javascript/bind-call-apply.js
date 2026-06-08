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

// .call() with a callback identifier after the this-context
function processItem(item) {
  return item;
}
var items = [1, 2, 3];

export function runCallWithCallback() {
  items.forEach.call(items, processItem);
}
