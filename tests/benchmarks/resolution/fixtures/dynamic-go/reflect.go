// Fixture: Go reflection patterns
// MethodByName("name") → resolved as reflection kind
// MethodByName(variable) → flagged as computed-key
package main

import "reflect"

func Greet(name string) string {
	return "Hello, " + name
}

func Farewell(name string) string {
	return "Goodbye, " + name
}

// v.MethodByName("Greet") — reflection kind, resolved to Greet()
func runMethodByNameLiteral(v reflect.Value) reflect.Value {
	return v.MethodByName("Greet")
}

// v.MethodByName(name) — computed-key kind, flagged as sink edge
func runMethodByNameVariable(v reflect.Value, name string) reflect.Value {
	return v.MethodByName(name)
}
