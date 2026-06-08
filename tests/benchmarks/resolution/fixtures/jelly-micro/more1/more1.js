// Jelly micro-test: more1 — array iteration patterns (for-of, Set, Array.from)

function fn1() {}
function fn2() {}
function fn3() {}
function fn4() {}
function fn5() {}
function fn6() {}
function fn7() {}
function fn8() {}

// for-of over plain array
function iterPlain() {
  const arr = [fn1, fn2];
  for (const f of arr) {
    f();
  }
}

// for-of over Set constructed from array
function iterSet() {
  const arr = [fn3, fn4];
  const s = new Set(arr);
  for (const f of s) {
    f();
  }
}

// Array.from with named callback
function mapCallback(item) {
  item();
}
function runFrom() {
  const arr = [fn5, fn6];
  Array.from(arr, mapCallback);
}

// spread into callback consumers
function consumer1(x, y) {
  x();
  y();
}
function consumer2(x, y) {
  x();
  y();
}

function runSpread() {
  const batch1 = [fn7, fn8];
  consumer1(...batch1);
}

const batch2 = [fn1, fn2];
consumer2(...batch2);
