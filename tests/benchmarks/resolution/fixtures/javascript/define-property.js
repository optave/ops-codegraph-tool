// Targets referenced through property descriptor APIs.
function f1() {
  return 1;
}
function f2() {
  return 2;
}

// Object.defineProperty(obj, "key", { value: fn }) → obj.key() resolves to fn
function _defProp() {
  const obj = {};
  Object.defineProperty(obj, 'f', { value: f1 });
  obj.f();
}

// Object.defineProperties(obj, { key: { value: fn } }) → obj.key() resolves to fn
function _defProps() {
  const obj = {};
  Object.defineProperties(obj, {
    f1: { value: f1 },
    f2: { value: f2 },
  });
  obj.f1();
  obj.f2();
}

// Object.create({ key: fn }) → obj.key() resolves via prototype
function _create() {
  const obj = Object.create({ f1, f2 });
  obj.f1();
  obj.f2();
}

// Object.defineProperty accessor this-dispatch:
// When getter is registered as a get accessor for accessorTarget, `this` inside getter
// refers to accessorTarget. So this.baz() → accessorTarget.baz → baz.
function baz() {
  return 42;
}

const accessorTarget = { baz };

function getter() {
  this.baz();
}

Object.defineProperty(accessorTarget, 'bar', { get: getter });
