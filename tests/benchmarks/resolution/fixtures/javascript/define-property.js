// Targets referenced through property descriptor APIs.
function f1() {
  return 1;
}
function f2() {
  return 2;
}

// Object.defineProperty(obj, "key", { value: fn }) → obj.key() resolves to fn
function defProp() {
  const obj = {};
  Object.defineProperty(obj, 'f', { value: f1 });
  obj.f();
}

// Object.defineProperties(obj, { key: { value: fn } }) → obj.key() resolves to fn
function defProps() {
  const obj = {};
  Object.defineProperties(obj, {
    f1: { value: f1 },
    f2: { value: f2 },
  });
  obj.f1();
  obj.f2();
}

// Object.create({ key: fn }) → obj.key() resolves via prototype
function create() {
  const obj = Object.create({ f1, f2 });
  obj.f1();
  obj.f2();
}
