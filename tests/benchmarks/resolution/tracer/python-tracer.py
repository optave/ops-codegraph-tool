#!/usr/bin/env python3
"""
Dynamic call tracer for Python fixtures.
Uses sys.settrace() to capture caller->callee edges at runtime.

Usage: python python-tracer.py <fixture-dir>
Outputs: { "edges": [...] } JSON to stdout
"""
import sys
import os
import json
import importlib.util

fixture_dir = sys.argv[1] if len(sys.argv) > 1 else None
if not fixture_dir:
    print("Usage: python-tracer.py <fixture-dir>", file=sys.stderr)
    sys.exit(1)

fixture_dir = os.path.abspath(fixture_dir)

edges = []
seen = set()
call_stack = []


def is_fixture_file(filename):
    """Only trace files within the fixture directory."""
    if not filename:
        return False
    if filename.startswith("<"):
        return False
    try:
        abs_path = os.path.normcase(os.path.abspath(filename))
        return abs_path.startswith(os.path.normcase(fixture_dir))
    except (ValueError, TypeError):
        return False


def get_basename(path):
    return os.path.basename(path)


def trace_calls(frame, event, arg):
    if event == "call":
        filename = frame.f_code.co_filename
        if not is_fixture_file(filename):
            return trace_calls

        funcname = frame.f_code.co_name
        basename = get_basename(filename)

        # Skip module-level code
        if funcname == "<module>":
            return trace_calls

        # Determine qualified name
        qualname = funcname
        if funcname == "__init__":
            # Constructor: use class name only (matches expected-edges format)
            if "self" in frame.f_locals:
                qualname = type(frame.f_locals["self"]).__name__
        elif "self" in frame.f_locals:
            cls_name = type(frame.f_locals["self"]).__name__
            qualname = f"{cls_name}.{funcname}"
        elif "cls" in frame.f_locals and hasattr(frame.f_locals["cls"], "__name__"):
            cls_name = frame.f_locals["cls"].__name__
            qualname = f"{cls_name}.{funcname}"

        # Record edge from caller
        if call_stack:
            caller = call_stack[-1]
            key = f"{caller['name']}@{caller['file']}->{qualname}@{basename}"
            if key not in seen:
                seen.add(key)
                edges.append(
                    {
                        "source_name": caller["name"],
                        "source_file": caller["file"],
                        "target_name": qualname,
                        "target_file": basename,
                    }
                )

        call_stack.append({"name": qualname, "file": basename})
        return trace_calls

    elif event == "return":
        filename = frame.f_code.co_filename
        funcname = frame.f_code.co_name
        if (
            is_fixture_file(filename)
            and funcname != "<module>"
            and call_stack
        ):
            call_stack.pop()
        return trace_calls

    return trace_calls


# Add fixture dir to Python path so imports resolve
sys.path.insert(0, fixture_dir)

# Find the main entry point
main_file = os.path.join(fixture_dir, "main.py")
if not os.path.exists(main_file):
    print(f"No main.py found in {fixture_dir}", file=sys.stderr)
    sys.exit(1)

# Set up tracing and run
sys.settrace(trace_calls)
try:
    spec = importlib.util.spec_from_file_location("__main__", main_file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
except Exception:
    pass  # Swallow errors - we only care about call edges
finally:
    sys.settrace(None)

# Output edges as JSON
print(json.dumps({"edges": edges}, indent=2))
