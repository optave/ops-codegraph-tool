// Fixture: TypeScript decorator dispatch patterns
// @Foo (bare identifier) → reflection kind, resolves to Foo
// @Foo() (call expression) → normal call, already resolved by standard extraction

export function Log(target: unknown): void {
  // decorator implementation
}

export const validators = {
  required: (target: unknown): void => {
    // decorator
  },
};

// @Log (bare decorator — reflection kind, calls Log)
@Log
export class UserController {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

// @Log() (call expression decorator — resolved by standard call extraction)
@Log()
export class OrderController {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}
