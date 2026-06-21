// Phase 6: Swift dynamic dispatch patterns
// NSSelectorFromString("name") → reflection kind
// performSelector → flagged as unresolved-dynamic
import Foundation

func greet(_ name: String) -> String {
    return "Hello, \(name)"
}

func farewell(_ name: String) -> String {
    return "Goodbye, \(name)"
}

// NSSelectorFromString("greet") — reflection kind, resolves to top-level greet()
func runNSSelectorFromString() -> Selector {
    return NSSelectorFromString("greet")
}

// NSSelectorFromString with farewell
func runNSSelectorFarewell() -> Selector {
    return NSSelectorFromString("farewell")
}
