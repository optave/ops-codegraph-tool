// Pre-ES6 OOP via prototype property assignment with identifier alias.
const f = () => {};

class A {}

A.prototype.t = f;

export function testPrototypeAlias() {
  new A().t();
}
