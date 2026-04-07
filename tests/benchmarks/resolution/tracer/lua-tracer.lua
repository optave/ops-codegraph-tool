#!/usr/bin/env lua
-- Dynamic call tracer for Lua fixtures.
-- Uses debug.sethook to capture caller->callee edges at runtime.
--
-- Usage: lua lua-tracer.lua <fixture-dir>
-- Outputs: { "edges": [...] } JSON to stdout

local fixture_dir = arg[1]
if not fixture_dir then
    io.stderr:write("Usage: lua lua-tracer.lua <fixture-dir>\n")
    os.exit(1)
end

-- Normalize path separators
fixture_dir = fixture_dir:gsub("\\", "/")
if not fixture_dir:match("/$") then fixture_dir = fixture_dir .. "/" end

local edges = {}
local seen = {}
local call_stack = {}

-- Track function -> qualified name mapping for module table members
local func_registry = {}

local function basename(path)
    if not path then return nil end
    return path:match("[^/\\]+$") or path
end

local function is_fixture_file(source)
    if not source then return false end
    if source:sub(1, 1) == "@" then source = source:sub(2) end
    source = source:gsub("\\", "/")
    -- Accept files in fixture_dir or relative paths (single filename)
    return source:find(fixture_dir, 1, true) ~= nil
        or (not source:find("/") and source:match("%.lua$"))
end

-- Override require to register module exports
local orig_require = require
local function traced_require(modname)
    local mod = orig_require(modname)
    if type(mod) == "table" then
        -- Register all functions in the module table as "M.funcname"
        for key, val in pairs(mod) do
            if type(val) == "function" and not func_registry[val] then
                func_registry[val] = "M." .. key
            end
        end
    end
    return mod
end
require = traced_require

local function hook(event)
    local info = debug.getinfo(2, "nSf")
    if not info or not info.source then return end
    if not is_fixture_file(info.source) then return end

    if event == "call" then
        local func = info.func
        local source = info.source
        if source:sub(1, 1) == "@" then source = source:sub(2) end
        local file = basename(source)

        -- Determine function name: prefer registry, then debug name
        local name = func_registry[func] or info.name
        if not name or name == "?" or name == "" then return end

        -- Record edge from caller
        if #call_stack > 0 then
            local caller = call_stack[#call_stack]
            local key = caller.name .. "@" .. caller.file .. "->" .. name .. "@" .. file
            if not seen[key] then
                seen[key] = true
                edges[#edges + 1] = {
                    source_name = caller.name,
                    source_file = caller.file,
                    target_name = name,
                    target_file = file,
                }
            end
        end

        call_stack[#call_stack + 1] = { name = name, file = file }

    elseif event == "return" then
        if #call_stack > 0 then
            table.remove(call_stack)
        end
    end
end

-- Add fixture dir to package.path
package.path = fixture_dir .. "?.lua;" .. fixture_dir .. "?/init.lua;" .. package.path

-- Set up hook and run
debug.sethook(hook, "cr")

local ok, err = pcall(dofile, fixture_dir .. "main.lua")
if not ok then
    -- Swallow errors - we only care about call edges
end

debug.sethook()

-- Output JSON manually (no json library dependency)
local function escape_json(s)
    return s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
end

io.write('{\n  "edges": [\n')
for i, edge in ipairs(edges) do
    io.write('    {\n')
    io.write(string.format('      "source_name": "%s",\n', escape_json(edge.source_name)))
    io.write(string.format('      "source_file": "%s",\n', escape_json(edge.source_file)))
    io.write(string.format('      "target_name": "%s",\n', escape_json(edge.target_name)))
    io.write(string.format('      "target_file": "%s"\n', escape_json(edge.target_file)))
    if i < #edges then
        io.write('    },\n')
    else
        io.write('    }\n')
    end
end
io.write('  ]\n}\n')
