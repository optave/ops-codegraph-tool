// Fixture: .call/.apply/.bind reflection patterns
// Resolved as: reflection kind, dynamic=true

export function greet(name) {
  return `Hello, ${name}`;
}

export function invoker(ctx, arg) {
  return `${ctx}: ${arg}`;
}

export function runCall(ctx) {
  // greet.call(ctx, "world") — reflection: resolves to greet()
  return greet.call(ctx, 'world');
}

export function runApply(ctx) {
  // greet.apply(ctx, ["world"]) — reflection: resolves to greet()
  return greet.apply(ctx, ['world']);
}

export function runInvokerCall(handler, ctx) {
  // invoker.call(handler, 10) — reflection: resolves to invoker()
  return invoker.call(handler, 10);
}
