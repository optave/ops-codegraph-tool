// Jelly micro-test: spread — named function references spread as call arguments

function a() {}
function b() {}
function c() {}
function d() {}

function f(x, y) { x(); y(); }
function g(x, y) { x(); y(); }

const arr1 = [a, b];
f(...arr1);  // f→a, f→b

const arr2 = [c, d];
g(...arr2);  // g→c, g→d
