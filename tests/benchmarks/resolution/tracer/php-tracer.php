#!/usr/bin/env php
<?php
/**
 * Dynamic call tracer for PHP fixtures.
 * Uses register_tick_function + debug_backtrace to capture caller->callee edges.
 *
 * Usage: php php-tracer.php <fixture-dir>
 * Outputs: { "edges": [...] } JSON to stdout
 */

declare(ticks=1);

$fixture_dir = $argv[1] ?? null;
if (!$fixture_dir) {
    fwrite(STDERR, "Usage: php php-tracer.php <fixture-dir>\n");
    exit(1);
}

$fixture_dir = realpath($fixture_dir);
if (!$fixture_dir) {
    fwrite(STDERR, "Fixture directory not found\n");
    exit(1);
}

$__tracer_edges = [];
$__tracer_seen = [];
$__tracer_prev_stack = [];

function __tracer_is_fixture_file(string $file): bool {
    global $fixture_dir;
    return strpos(realpath($file) ?: $file, $fixture_dir) === 0;
}

function __tracer_tick(): void {
    global $__tracer_edges, $__tracer_seen, $__tracer_prev_stack, $fixture_dir;

    $bt = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 10);

    // Build current call stack of fixture-only functions
    $current_stack = [];
    foreach ($bt as $i => $frame) {
        if ($i === 0) continue; // Skip __tracer_tick itself
        if (!isset($frame['file'])) continue;
        if (!__tracer_is_fixture_file($frame['file'])) continue;

        $func = $frame['function'] ?? '';
        if ($func === '__tracer_tick' || $func === '') continue;

        $file = basename($frame['file']);

        // Build qualified name
        if (isset($frame['class'])) {
            $cls = $frame['class'];
            if ($func === '__construct') {
                $qualname = $cls;
            } else {
                $qualname = "$cls.$func";
            }
        } else {
            $qualname = $func;
        }

        $current_stack[] = ['name' => $qualname, 'file' => $file];
    }

    // Detect new calls by comparing with previous stack
    $current_stack = array_reverse($current_stack);

    if (count($current_stack) > count($__tracer_prev_stack)) {
        // New function entered - record edge from caller to callee
        $callee_idx = count($current_stack) - 1;
        $caller_idx = $callee_idx - 1;

        if ($caller_idx >= 0 && $callee_idx >= 0) {
            $caller = $current_stack[$caller_idx];
            $callee = $current_stack[$callee_idx];
            $key = "{$caller['name']}@{$caller['file']}->{$callee['name']}@{$callee['file']}";

            if (!isset($__tracer_seen[$key])) {
                $__tracer_seen[$key] = true;
                $__tracer_edges[] = [
                    'source_name' => $caller['name'],
                    'source_file' => $caller['file'],
                    'target_name' => $callee['name'],
                    'target_file' => $callee['file'],
                ];
            }
        }
    }

    $__tracer_prev_stack = $current_stack;
}

register_tick_function('__tracer_tick');

// Change to fixture directory and run
chdir($fixture_dir);

try {
    // Find entry point
    $main_file = $fixture_dir . DIRECTORY_SEPARATOR . 'index.php';
    if (!file_exists($main_file)) {
        $main_file = $fixture_dir . DIRECTORY_SEPARATOR . 'main.php';
    }
    if (file_exists($main_file)) {
        include $main_file;
    } else {
        fwrite(STDERR, "No index.php or main.php found in $fixture_dir\n");
        exit(1);
    }
} catch (Throwable $e) {
    // Swallow errors - we only care about call edges
}

unregister_tick_function('__tracer_tick');

// Output edges as JSON
echo json_encode(['edges' => $__tracer_edges], JSON_PRETTY_PRINT) . "\n";
