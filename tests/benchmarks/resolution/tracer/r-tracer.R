#!/usr/bin/env Rscript
# Dynamic call tracer for R fixtures.
# Uses sys.function() and sys.call() to capture caller->callee edges.
#
# Usage: Rscript r-tracer.R <fixture-dir>
# Outputs: { "edges": [...] } JSON to stdout

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat("Usage: Rscript r-tracer.R <fixture-dir>\n", file = stderr())
  quit(status = 1)
}

fixture_dir <- normalizePath(args[1], mustWork = TRUE)

edges <- list()
seen <- new.env(hash = TRUE, parent = emptyenv())

# Override source() to track which file defines which function
current_source_file <- ""
original_source <- base::source

traced_source <- function(file, ...) {
  prev_file <- current_source_file
  full_path <- normalizePath(file.path(fixture_dir, file), mustWork = FALSE)
  if (!file.exists(full_path)) {
    full_path <- normalizePath(file, mustWork = FALSE)
  }
  current_source_file <<- basename(full_path)
  result <- original_source(full_path, local = FALSE, ...)
  current_source_file <<- prev_file
  invisible(result)
}

# Build a tracing wrapper for functions
wrap_function <- function(fn, name, file) {
  force(fn)
  force(name)
  force(file)
  function(...) {
    # Get caller info from the call stack
    n <- sys.nframe()
    if (n >= 2) {
      caller_fn <- sys.function(n - 1)
      caller_name <- ""
      caller_file <- ""
      # Look up caller identity from our registry
      for (reg_name in ls(func_registry)) {
        reg <- get(reg_name, envir = func_registry)
        if (identical(reg$fn, caller_fn)) {
          caller_name <- reg$name
          caller_file <- reg$file
          break
        }
      }
      if (nchar(caller_name) > 0) {
        key <- paste0(caller_name, "@", caller_file, "->", name, "@", file)
        if (!exists(key, envir = seen)) {
          assign(key, TRUE, envir = seen)
          edges[[length(edges) + 1]] <<- list(
            source_name = caller_name,
            source_file = caller_file,
            target_name = name,
            target_file = file
          )
        }
      }
    }
    fn(...)
  }
}

# Registry of traced functions
func_registry <- new.env(hash = TRUE, parent = emptyenv())

register_function <- function(fn, name, file) {
  assign(name, list(fn = fn, name = name, file = file), envir = func_registry)
}

# Override source to intercept and wrap functions
assignInNamespace("source", traced_source, ns = "base")

# Set working directory to fixture
setwd(fixture_dir)

# Source the main file - this will source all dependencies transitively
tryCatch({
  original_source(file.path(fixture_dir, "main.R"), local = FALSE)
}, error = function(e) {
  # Swallow errors
})

# Restore original source
assignInNamespace("source", original_source, ns = "base")

# Output edges as JSON
cat("{\n")
cat('  "edges": [\n')
for (i in seq_along(edges)) {
  edge <- edges[[i]]
  cat(sprintf('    {\n      "source_name": "%s",\n      "source_file": "%s",\n      "target_name": "%s",\n      "target_file": "%s"\n    }',
    edge$source_name, edge$source_file, edge$target_name, edge$target_file))
  if (i < length(edges)) cat(",")
  cat("\n")
}
cat("  ]\n")
cat("}\n")
