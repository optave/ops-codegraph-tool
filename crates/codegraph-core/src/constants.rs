/// Maximum recursion depth for AST traversal to prevent stack overflow
/// on deeply nested trees. Used by extractors, complexity, CFG, and dataflow.
pub const MAX_WALK_DEPTH: usize = 200;
