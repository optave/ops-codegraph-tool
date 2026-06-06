// Pre-ES6 OOP via constructor function + prototype object literal.
function C() {}

C.prototype = {
  foo: () => {},
};

export function runPrototypes() {
  var v = new C();
  v.foo();
}
