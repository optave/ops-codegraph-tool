import type { Serializer, User } from './types';

export class JsonSerializer implements Serializer<User> {
  serialize(item: User): string {
    return formatJson(item);
  }

  deserialize(raw: string): User {
    return parseJson(raw);
  }
}

function formatJson(obj: unknown): string {
  return JSON.stringify(obj);
}

function parseJson(raw: string): User {
  return JSON.parse(raw) as User;
}
