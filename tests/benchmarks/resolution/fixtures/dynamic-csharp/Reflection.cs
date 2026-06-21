// Phase 6: C# reflection patterns
// GetMethod("name") → reflection kind
// method.Invoke() → unresolved-dynamic
using System.Reflection;

public class Reflection {
    public static string Greet(string name) => $"Hello, {name}";

    // type.GetMethod("Greet") — reflection kind, resolvable in theory
    public static MethodInfo RunGetMethod(Type type) {
        return type.GetMethod("Greet");
    }

    // method.Invoke(target, args) — unresolved-dynamic
    public static object RunInvoke(MethodInfo method, object target) {
        return method.Invoke(target, new object[] { "world" });
    }
}
