export interface Repository<T> {
  findById(id: string): T | null;
  save(item: T): void;
  delete(id: string): boolean;
}

export interface Serializer<T> {
  serialize(item: T): string;
  deserialize(raw: string): T;
}

export interface User {
  id: string;
  name: string;
  email: string;
}
