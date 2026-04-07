#!/usr/bin/env elixir
# Dynamic call tracer for Elixir fixtures.
# Uses :dbg tracing to capture caller->callee edges at runtime.
#
# Usage: elixir elixir-tracer.exs <fixture-dir>
# Outputs: { "edges": [...] } JSON to stdout

fixture_dir = System.argv() |> List.first()

unless fixture_dir do
  IO.puts(:stderr, "Usage: elixir elixir-tracer.exs <fixture-dir>")
  System.halt(1)
end

fixture_dir = Path.expand(fixture_dir)

# Agent to collect edges
{:ok, agent} = Agent.start_link(fn -> %{edges: [], seen: MapSet.new(), stack: []} end)

record_edge = fn caller_name, caller_file, callee_name, callee_file ->
  Agent.update(agent, fn state ->
    key = "#{caller_name}@#{caller_file}->#{callee_name}@#{callee_file}"
    if MapSet.member?(state.seen, key) do
      state
    else
      edge = %{
        "source_name" => caller_name,
        "source_file" => caller_file,
        "target_name" => callee_name,
        "target_file" => callee_file
      }
      %{state |
        edges: [edge | state.edges],
        seen: MapSet.put(state.seen, key)
      }
    end
  end)
end

# Compile fixture modules
fixture_files = Path.wildcard(Path.join(fixture_dir, "*.ex"))

# Map module names to files
module_file_map = for file <- fixture_files, into: %{} do
  basename = Path.basename(file)
  content = File.read!(file)
  # Extract module name from defmodule
  case Regex.run(~r/defmodule\s+(\S+)/, content) do
    [_, mod_name] -> {mod_name, basename}
    _ -> {basename, basename}
  end
end

# Compile all fixture files
for file <- fixture_files do
  Code.compile_file(file)
end

# Trace function calls using :erlang.trace
# Set up a tracer process
tracer_pid = spawn(fn ->
  receive_loop = fn loop_fn ->
    receive
      {:trace, _pid, :call, {mod, fun, _arity}} ->
        mod_name = Atom.to_string(mod) |> String.replace("Elixir.", "")
        fun_name = Atom.to_string(fun)
        file = Map.get(module_file_map, mod_name, "unknown.ex")
        qualname = "#{mod_name}.#{fun_name}"

        Agent.update(agent, fn state ->
          new_stack = [{qualname, file} | state.stack]
          case state.stack do
            [{caller_name, caller_file} | _] ->
              key = "#{caller_name}@#{caller_file}->#{qualname}@#{file}"
              if MapSet.member?(state.seen, key) do
                %{state | stack: new_stack}
              else
                edge = %{
                  "source_name" => caller_name,
                  "source_file" => caller_file,
                  "target_name" => qualname,
                  "target_file" => file
                }
                %{state |
                  edges: [edge | state.edges],
                  seen: MapSet.put(state.seen, key),
                  stack: new_stack
                }
              end
            _ ->
              %{state | stack: new_stack}
          end
        end)
        loop_fn.(loop_fn)

      {:trace, _pid, :return_from, _mfa, _return} ->
        Agent.update(agent, fn state ->
          case state.stack do
            [_ | rest] -> %{state | stack: rest}
            _ -> state
          end
        end)
        loop_fn.(loop_fn)

      :stop ->
        :ok

      _ ->
        loop_fn.(loop_fn)
    after
      5000 -> :ok
    end
  end
  receive_loop.(receive_loop)
end)

# Enable tracing for fixture modules
:erlang.trace(self(), true, [:call, :return_to, {:tracer, tracer_pid}])

# Add trace patterns for all fixture modules
for file <- fixture_files do
  content = File.read!(file)
  case Regex.run(~r/defmodule\s+(\S+)/, content) do
    [_, mod_name] ->
      mod = String.to_atom("Elixir." <> mod_name)
      try do
        :erlang.trace_pattern({mod, :_, :_}, true, [:local])
      rescue
        _ -> :ok
      end
    _ -> :ok
  end
end

# Run the main module
try do
  if Code.ensure_loaded?(Main) do
    Main.run()
  end
rescue
  _ -> :ok
end

# Stop tracing
:erlang.trace(self(), false, [:call, :return_to])
send(tracer_pid, :stop)
Process.sleep(100)

# Output edges as JSON
state = Agent.get(agent, & &1)
edges = Enum.reverse(state.edges)

try do
  result = Jason.encode!(%{"edges" => edges}, pretty: true)
  IO.puts(result)
rescue
  _ ->
    # Fallback: manual JSON output if Jason is not available
    state = Agent.get(agent, & &1)
    edges = Enum.reverse(state.edges)
    IO.puts("{")
    IO.puts("  \"edges\": [")
    edges
    |> Enum.with_index()
    |> Enum.each(fn {edge, idx} ->
      comma = if idx < length(edges) - 1, do: ",", else: ""
      escaped = fn val ->
        val
        |> String.replace("\\", "\\\\")
        |> String.replace("\"", "\\\"")
      end
      IO.puts("    {")
      IO.puts("      \"source_name\": \"#{escaped.(edge["source_name"])}\",")
      IO.puts("      \"source_file\": \"#{escaped.(edge["source_file"])}\",")
      IO.puts("      \"target_name\": \"#{escaped.(edge["target_name"])}\",")
      IO.puts("      \"target_file\": \"#{escaped.(edge["target_file"])}\"")
      IO.puts("    }#{comma}")
    end)
    IO.puts("  ]")
    IO.puts("}")
end
