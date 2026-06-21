-- Phase 6: Lua dynamic dispatch patterns
-- t["method"]() → computed-literal, resolved
-- load(code) → eval kind, flagged
-- t[k]() → computed-key kind, flagged

local function greet(name)
  return "Hello, " .. name
end

-- t["greet"]() — computed-literal with string key; resolves to greet()
local function run_literal_dispatch(t)
  t["greet"]("world")
end

-- load(code) — dynamic code execution; always flagged
local function run_load(code)
  local fn = load(code)
  if fn then fn() end
end

-- t[k]() — variable key; flagged as computed-key
local function run_variable_dispatch(t, k)
  t[k]("world")
end
