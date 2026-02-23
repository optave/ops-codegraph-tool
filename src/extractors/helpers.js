export function nodeEndLine(node) {
  return node.endPosition.row + 1;
}

export function findChild(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === type) return node.child(i);
  }
  return null;
}
