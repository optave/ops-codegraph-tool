// Jelly micro-test: rest — object destructuring rest parameter dispatch

function e1() {}
function e2() {}
function e3() {}
function e4() {}

const obj = { e1, e2, e3, e4 };

function f3({ e1: eee1, ...eerest }) {
  eee1();
  eerest.e4(); // eerest.e4 === obj.e4 === e4 when called as f3(obj)
}
f3(obj);
