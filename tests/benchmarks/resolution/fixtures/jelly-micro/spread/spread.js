// Jelly micro-test: spread — named function references spread as call arguments

function a() {}
function b() {}
function c() {}
function d() {}
function e() {}
function h() {}

function f(x, y) {
  x();
  y();
}
function g(x, y) {
  x();
  y();
}
function p(x) {
  x();
}
function q(x, y, z) {
  x();
  y();
  z();
}

const arr1 = [a, b];
f(...arr1); // f→a, f→b

const arr2 = [c, d];
g(...arr2); // g→c, g→d

p(...[e]); // p→e  (inline single-element array)
q(...[a, b, c]); // q→a, q→b, q→c  (inline multi-element array)
q(e, ...[h, d]); // q→e (pos 0), q→h (pos 1), q→d (pos 2)  (mixed: identifier + inline spread)
