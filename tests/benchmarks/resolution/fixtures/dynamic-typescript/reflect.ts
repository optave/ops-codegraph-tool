// Fixture: Reflect API dispatch patterns
// Reflect.apply/construct → reflection kind, target resolved
// Reflect.get with string key → computed-literal kind, resolved
// Reflect.get with variable key → computed-key kind, flagged

export function greet(name: string): string {
  return `Hello, ${name}`;
}

export function farewell(name: string): string {
  return `Goodbye, ${name}`;
}

export class UserService {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export function runReflectApply(ctx: unknown): string {
  // Reflect.apply(greet, ctx, ['world']) — resolves to greet
  return Reflect.apply(greet, ctx, ['world']) as string;
}

export function runReflectConstruct(): UserService {
  // Reflect.construct(UserService, ['Alice']) — resolves to UserService
  return Reflect.construct(UserService, ['Alice']) as UserService;
}

export function runReflectGetLiteral(obj: Record<string, unknown>): unknown {
  // Reflect.get(obj, 'greet') — computed-literal, resolves to greet
  return Reflect.get(obj, 'greet');
}

export function runReflectGetVariable(obj: Record<string, unknown>, key: string): unknown {
  // Reflect.get(obj, key) — computed-key, flagged as sink edge
  return Reflect.get(obj, key);
}
