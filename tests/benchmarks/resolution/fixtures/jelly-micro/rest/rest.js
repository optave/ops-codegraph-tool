// Jelly micro-test: object destructuring rest parameters
// Tests call resolution via eerest.method() where eerest is a rest binding
// of an object destructuring parameter and the argument is a known object.

function e1() {
  console.log('31');
}
function e2() {
  console.log('32');
}
function e3() {
  console.log('33');
}
function e4() {
  console.log('34');
}

var obj = { e1, e2, e3, e4 };

// f3's first param destructures obj: eee1 = obj.e1, eerest = { e2, e3, e4 }.
// eerest.e4() should resolve to e4.
function f3({ e1: eee1, ...eerest }) {
  eee1(); // direct call to destructured-alias — resolves to e1
  eerest.e4(); // rest-receiver call — expected edge: f3 → e4
}
f3(obj);
