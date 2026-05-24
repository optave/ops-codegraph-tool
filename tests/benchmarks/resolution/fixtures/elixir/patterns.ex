defmodule Patterns do
  def fetch(url, timeout \\ 5000, retries \\ 3) do
    {url, timeout, retries}
  end

  def first_of({x, _y}) do
    x
  end

  def name_of(%{name: name, email: _email}) do
    name
  end

  def id_of(%User{id: id}) do
    id
  end

  def head_of([head | _tail]) do
    head
  end

  def all_of([a, b, _c]) do
    {a, b}
  end
end
