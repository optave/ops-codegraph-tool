// pts-spread: spread-into-parameters call patterns
function sprFn1() {}
function sprFn2() {}
function sprFn3() {}
function sprFn4() {}

function consumer1(x, y) {
  x();
  y();
}
function consumer2(x, y) {
  x();
  y();
}

function _runSpread1() {
  const batch1 = [sprFn1, sprFn2];
  consumer1(...batch1);
}

function _runSpread2() {
  const batch2 = [sprFn3, sprFn4];
  consumer2(...batch2);
}
