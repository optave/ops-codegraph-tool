const { add, square } = require('./math');

function sumOfSquares(a, b) {
  return add(square(a), square(b));
}

class Calculator {
  compute(x, y) {
    return sumOfSquares(x, y);
  }
}

// Chained call — exercises call-in-function-field (a().b()) parity
function formatResults(items) {
  return items.filter(Boolean).map(String);
}

module.exports = { sumOfSquares, Calculator, formatResults };
