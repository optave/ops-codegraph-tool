# Fixture: Python dynamic dispatch patterns
# getattr(obj, 'method') → resolved as reflection kind
# eval/exec → flagged as eval kind
# getattr(obj, variable) → flagged as computed-key


def greet(name: str) -> str:
    return f"Hello, {name}"


def farewell(name: str) -> str:
    return f"Goodbye, {name}"


def run_getattr_literal(obj: object) -> object:
    # getattr(obj, 'greet') — reflection kind, resolved to greet()
    return getattr(obj, 'greet')


def run_getattr_farewell(obj: object) -> object:
    # getattr(obj, 'farewell') — reflection kind, resolved to farewell()
    return getattr(obj, 'farewell')


def run_getattr_variable(obj: object, method_name: str) -> object:
    # getattr(obj, method_name) — computed-key kind, flagged as sink edge
    return getattr(obj, method_name)


def run_eval(code: str) -> object:
    # eval(code) — eval kind, always flagged
    return eval(code)  # noqa: S307


def run_exec(code: str) -> None:
    # exec(code) — eval kind, always flagged
    exec(code)  # noqa: S102
