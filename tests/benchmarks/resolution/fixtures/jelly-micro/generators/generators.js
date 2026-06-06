// Jelly micro-test: generators
// Tests call resolution in/between generator functions.

function* gen1() {
  yield 42;
}

function* gen2() {
  yield* gen1(); // yield* delegation → edge gen2 → gen1
}

function* gen3() {
  const it = gen9(); // direct call → edge gen3 → gen9
  it.next();
  yield it;
}

function gen4helper() {
  return 1;
}

function* gen4() {
  yield gen4helper(); // call to regular function → edge gen4 → gen4helper
}

function* gen5() {
  yield* gen2(); // yield* delegation → edge gen5 → gen2
  yield* gen4(); // yield* delegation → edge gen5 → gen4
}

function* gen6() {
  yield gen7(); // call to sibling generator → edge gen6 → gen7
}

function* gen7() {
  yield gen6(); // call to sibling generator → edge gen7 → gen6
}

function* gen8() {
  yield 1;
  yield 2;
}

function* gen9() {
  yield* gen8(); // yield* delegation → edge gen9 → gen8
}

// Variable-declared generator
const gen10 = function* () {
  yield gen8(); // call from var-declared generator → edge gen10 → gen8
};

// Entry: call some generators
gen3();
gen5();
gen10();
