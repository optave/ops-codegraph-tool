defmodule DynamicDispatch do
  # Fixture: Elixir dynamic dispatch via apply/3
  # apply(module, :function, args) → reflection kind
  # apply(module, variable, args) → computed-key

  def greet(name), do: "Hello, #{name}"
  def farewell(name), do: "Goodbye, #{name}"

  # apply(DynamicDispatch, :greet, ["world"]) — reflection kind
  def run_apply_atom do
    apply(DynamicDispatch, :greet, ["world"])
  end

  # apply(module, fn_name, args) — computed-key kind
  def run_apply_variable(fn_name) do
    apply(DynamicDispatch, fn_name, ["world"])
  end
end
