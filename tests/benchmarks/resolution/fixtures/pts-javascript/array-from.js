// pts-array-from: Array.from with a named mapping callback
function arrFn1() {}
function arrFn2() {}

function mapCallback(item) {
  item();
}

function _runFrom() {
  const arr = [arrFn1, arrFn2];
  Array.from(arr, mapCallback);
}
