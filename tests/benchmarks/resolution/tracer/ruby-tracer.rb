#!/usr/bin/env ruby
# frozen_string_literal: true

# Dynamic call tracer for Ruby fixtures.
# Uses TracePoint to capture caller->callee edges at runtime.
#
# Usage: ruby ruby-tracer.rb <fixture-dir>
# Outputs: { "edges": [...] } JSON to stdout

require "json"

fixture_dir = ARGV[0]
unless fixture_dir
  $stderr.puts "Usage: ruby-tracer.rb <fixture-dir>"
  exit 1
end

fixture_dir = File.expand_path(fixture_dir)

edges = []
seen = {}
call_stack = []

# Top-level classes to skip qualified naming for
SKIP_CLASSES = %w[Object Kernel BasicObject].freeze

trace = TracePoint.new(:call, :return) do |tp|
  path = tp.path
  next unless path && File.expand_path(path).start_with?(fixture_dir)

  basename = File.basename(path)

  case tp.event
  when :call
    method_name = tp.method_id.to_s
    defined_class = tp.defined_class.to_s

    # Build qualified name: skip Object/Kernel for top-level functions
    qualname = if method_name == "initialize"
      # Constructor: use just the class name
      defined_class.split("::").last
    elsif SKIP_CLASSES.include?(defined_class) || defined_class.start_with?("#<")
      method_name
    else
      "#{defined_class.split('::').last}.#{method_name}"
    end

    if call_stack.length > 0
      caller_info = call_stack.last
      key = "#{caller_info[:name]}@#{caller_info[:file]}->#{qualname}@#{basename}"
      unless seen[key]
        seen[key] = true
        edges << {
          source_name: caller_info[:name],
          source_file: caller_info[:file],
          target_name: qualname,
          target_file: basename
        }
      end
    end

    call_stack.push({ name: qualname, file: basename })

  when :return
    call_stack.pop if call_stack.length > 0
  end
end

# Add fixture dir to load path
$LOAD_PATH.unshift(fixture_dir)

main_file = File.join(fixture_dir, "main.rb")
unless File.exist?(main_file)
  $stderr.puts "No main.rb found in #{fixture_dir}"
  exit 1
end

trace.enable
begin
  load main_file
rescue StandardError
  # Swallow errors - we only care about call edges
ensure
  trace.disable
end

puts JSON.pretty_generate({ edges: edges })
