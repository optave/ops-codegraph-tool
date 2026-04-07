#!/usr/bin/env bash
# Dynamic call tracer for JVM languages (Java, Kotlin, Scala).
# Injects Thread.currentThread().getStackTrace() tracing, compiles, and runs.
#
# Usage: bash jvm-tracer.sh <fixture-dir> [java|kotlin|scala]
# Outputs: { "edges": [...] } JSON to stdout
# Requires: javac/java (Java), kotlinc (Kotlin), scalac (Scala)

set -euo pipefail

FIXTURE_DIR="${1:-}"
LANG="${2:-java}"

if [[ -z "$FIXTURE_DIR" ]]; then
    echo "Usage: jvm-tracer.sh <fixture-dir> [java|kotlin|scala]" >&2
    exit 1
fi

FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"

# Check for required tools
case "$LANG" in
    java)
        if ! command -v javac &>/dev/null; then
            echo '{"edges":[],"error":"javac not available"}'
            exit 0
        fi
        ;;
    kotlin)
        if ! command -v kotlinc &>/dev/null; then
            echo '{"edges":[],"error":"kotlinc not available"}'
            exit 0
        fi
        ;;
    scala)
        if ! command -v scalac &>/dev/null; then
            echo '{"edges":[],"error":"scalac not available"}'
            exit 0
        fi
        ;;
    groovy)
        if ! command -v groovyc &>/dev/null; then
            echo '{"edges":[],"error":"groovyc not available"}'
            exit 0
        fi
        ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Copy fixture files
case "$LANG" in
    java)   cp "$FIXTURE_DIR"/*.java "$TMP_DIR/" ;;
    kotlin) cp "$FIXTURE_DIR"/*.kt "$TMP_DIR/" ;;
    scala)  cp "$FIXTURE_DIR"/*.scala "$TMP_DIR/" ;;
    groovy) cp "$FIXTURE_DIR"/*.groovy "$TMP_DIR/" ;;
esac

# Create the Tracer utility class
cat > "$TMP_DIR/CallTracer.java" <<'JAVA'
import java.util.*;

public class CallTracer {
    private static final List<Map<String, String>> edges = new ArrayList<>();
    private static final Set<String> seen = new HashSet<>();

    public static void traceCall() {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        // [0] = getStackTrace, [1] = traceCall, [2] = callee, [3] = caller
        if (stack.length < 4) return;

        StackTraceElement callee = stack[2];
        StackTraceElement caller = stack[3];

        String calleeName = cleanName(callee);
        String calleeFile = callee.getFileName();
        String callerName = cleanName(caller);
        String callerFile = caller.getFileName();

        if (calleeFile == null || callerFile == null) return;
        if (calleeFile.equals("CallTracer.java") || callerFile.equals("CallTracer.java")) return;

        String key = callerName + "@" + callerFile + "->" + calleeName + "@" + calleeFile;
        if (!seen.contains(key)) {
            seen.add(key);
            Map<String, String> edge = new LinkedHashMap<>();
            edge.put("source_name", callerName);
            edge.put("source_file", callerFile);
            edge.put("target_name", calleeName);
            edge.put("target_file", calleeFile);
            edges.add(edge);
        }
    }

    private static String cleanName(StackTraceElement el) {
        String cls = el.getClassName();
        String method = el.getMethodName();
        // Strip package prefix
        int dot = cls.lastIndexOf('.');
        if (dot >= 0) cls = cls.substring(dot + 1);
        // Handle inner classes
        cls = cls.replace('$', '.');
        if (method.equals("<init>")) {
            return cls; // Constructor
        }
        if (method.equals("main")) {
            return "main"; // Entry point
        }
        return cls + "." + method;
    }

    public static void dump() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n  \"edges\": [\n");
        for (int i = 0; i < edges.size(); i++) {
            Map<String, String> e = edges.get(i);
            sb.append("    {\n");
            sb.append("      \"source_name\": \"").append(e.get("source_name")).append("\",\n");
            sb.append("      \"source_file\": \"").append(e.get("source_file")).append("\",\n");
            sb.append("      \"target_name\": \"").append(e.get("target_name")).append("\",\n");
            sb.append("      \"target_file\": \"").append(e.get("target_file")).append("\"\n");
            sb.append("    }");
            if (i < edges.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ]\n}");
        System.out.println(sb.toString());
    }
}
JAVA

# Inject traceCall() into each method
case "$LANG" in
    java)
        for javafile in "$TMP_DIR"/*.java; do
            base="$(basename "$javafile")"
            [[ "$base" == "CallTracer.java" ]] && continue
            # Add CallTracer.traceCall() after method opening braces
            # Match lines like: public void method(...) {
            # Use portable sed -i: GNU sed uses -i alone, BSD sed (macOS) requires -i ''
            if sed --version 2>/dev/null | grep -q GNU; then
                sed -i -E '/\)\s*\{$/{
                    /class |interface /!{
                        a\        CallTracer.traceCall();
                    }
                }' "$javafile"
                # Also inject into constructors
                sed -i -E '/\)\s*\{$/{
                    /class |interface /!s/$/\n        CallTracer.traceCall();/
                }' "$javafile" 2>/dev/null || true
            else
                sed -i '' -E '/\)\s*\{$/{
                    /class |interface /!{
                        a\        CallTracer.traceCall();
                    }
                }' "$javafile"
                # Also inject into constructors
                sed -i '' -E '/\)\s*\{$/{
                    /class |interface /!s/$/\n        CallTracer.traceCall();/
                }' "$javafile" 2>/dev/null || true
            fi
        done

        # Add dump call at end of main
        if sed --version 2>/dev/null | grep -q GNU; then
            sed -i '/public static void main/,/\}/ {
                /^\s*\}/ i\        CallTracer.dump();
            }' "$TMP_DIR/Main.java" 2>/dev/null || true
        else
            sed -i '' '/public static void main/,/\}/ {
                /^\s*\}/ i\        CallTracer.dump();
            }' "$TMP_DIR/Main.java" 2>/dev/null || true
        fi

        # Compile and run
        cd "$TMP_DIR"
        if javac *.java 2>/dev/null; then
            java -cp . Main 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"javac compilation failed"}'
        fi
        ;;

    kotlin)
        # For Kotlin, compile CallTracer.java first, then Kotlin files
        cd "$TMP_DIR"
        if javac CallTracer.java 2>/dev/null && kotlinc -cp . *.kt -include-runtime -d app.jar 2>/dev/null; then
            java -jar app.jar 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"kotlin compilation failed"}'
        fi
        ;;

    scala)
        cd "$TMP_DIR"
        if javac CallTracer.java 2>/dev/null && scalac -cp . *.scala 2>/dev/null; then
            scala -cp . Main 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"scala compilation failed"}'
        fi
        ;;

    groovy)
        cd "$TMP_DIR"
        if javac CallTracer.java 2>/dev/null && groovyc -cp . *.groovy 2>/dev/null; then
            groovy -cp . Main 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"groovy compilation failed"}'
        fi
        ;;
esac
