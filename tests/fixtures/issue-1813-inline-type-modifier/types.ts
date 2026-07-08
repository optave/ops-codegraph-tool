export function openRepo(): Repository {
  return {} as Repository;
}

export interface Repository {
  find(id: string): unknown;
}

export function computeSize(): number {
  return 1;
}

export interface Widget {
  size: number;
}
