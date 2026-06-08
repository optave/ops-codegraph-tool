/**
 * Fixture: two classes in the same file that both use `this.service`,
 * but assign different types.  Before the fix, the second class's
 * typeMap entry overwrote the first, causing one class to resolve
 * `this.service.method()` against the wrong type (false edge).
 */

export class ServiceA {
  doA() {}
}

export class ServiceB {
  doB() {}
}

export class ClassA {
  constructor() {
    this.service = new ServiceA();
  }

  runA() {
    this.service.doA();
  }
}

export class ClassB {
  constructor() {
    this.service = new ServiceB();
  }

  runB() {
    this.service.doB();
  }
}
