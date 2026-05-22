defmodule Main do
  def run do
    store = UserRepository.new_store()
    store = UserService.create_user(store, "u1", "Alice", "alice@example.com")
    user = UserService.get_user(store, "u1")
    IO.inspect(user)
    _all = UserService.list_users(store)
    label = UserService.display_user(store, "u1")
    IO.puts(label)
    store = UserService.remove_user(store, "u1")
    _ = Patterns.fetch("https://example.com")
    _ = Patterns.first_of({1, 2})
    _ = Patterns.name_of(%{name: "x", email: "x@y"})
    _ = Patterns.id_of(%User{id: 1})
    store
  end
end
