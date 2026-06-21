# Fixture: Ruby dynamic dispatch patterns
# send(:method) → resolved as reflection kind
# send(variable) → flagged as computed-key

def greet(name)
  "Hello, #{name}"
end

def farewell(name)
  "Goodbye, #{name}"
end

# obj.send(:greet) — reflection kind, resolved to greet()
def run_send_symbol(obj)
  obj.send(:greet, 'world')
end

# obj.public_send(:farewell) — reflection kind, resolved to farewell()
def run_public_send(obj)
  obj.public_send(:farewell, 'world')
end

# obj.send(method_name) — computed-key kind, flagged as sink edge
def run_send_variable(obj, method_name)
  obj.send(method_name, 'world')
end
