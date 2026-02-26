export function nodeEndLine(node) {
  return node.endPosition.row + 1;
}

export function findChild(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) return child;
  }
  return null;
}
