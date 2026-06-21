<?php
// Fixture: PHP dynamic dispatch patterns
// call_user_func('fn', args) → resolved as reflection kind
// $obj->$m() → flagged as unresolved-dynamic
// $fn() → flagged as unresolved-dynamic

function greet(string $name): string {
    return "Hello, {$name}";
}

function farewell(string $name): string {
    return "Goodbye, {$name}";
}

// call_user_func('greet', ...) — resolved to top-level greet()
function runCallUserFuncLiteral(): string {
    return call_user_func('greet', 'world');
}

// $obj->$m() — variable method name; unresolved-dynamic
function runVariableMethod(object $obj, string $m): mixed {
    return $obj->$m('world');
}

// $fn() — variable callable; unresolved-dynamic
function runVariableCallable(callable $fn): mixed {
    return $fn('world');
}
