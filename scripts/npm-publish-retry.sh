#!/usr/bin/env bash
# Retry wrapper for npm publish — handles transient registry errors (E404, E500, ETIMEDOUT).
# Between retries, checks whether the package already landed on the registry (slow-success
# scenario where the server accepted the upload but the client timed out before receiving 200).
#
# Usage: npm_publish_retry <pkg_name>@<version> <publish_command...>
#   e.g. npm_publish_retry "@optave/codegraph@3.9.0" npm publish ./pkg --access public
#
# Arguments:
#   $1        — package spec for idempotency check (e.g. "@optave/codegraph@3.9.0")
#   $2...$N   — the full npm publish command to execute

npm_publish_retry() {
  local pkg_spec="$1"
  shift
  local max_attempts=3
  local delay=10
  for attempt in $(seq 1 $max_attempts); do
    if "$@"; then
      return 0
    fi
    # Before retrying, check if the publish already landed (slow-success / ETIMEDOUT)
    if npm view "$pkg_spec" version 2>/dev/null; then
      echo "::notice::$pkg_spec is now visible on the registry — treating as success"
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "::warning::npm publish attempt $attempt/$max_attempts failed — retrying in ${delay}s..."
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done
  echo "::error::npm publish failed after $max_attempts attempts"
  return 1
}
