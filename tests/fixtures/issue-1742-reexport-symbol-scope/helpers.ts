export function formatDate(d: Date): string {
  return d.toISOString();
}

export function formatNumber(n: number): string {
  return n.toFixed(2);
}
