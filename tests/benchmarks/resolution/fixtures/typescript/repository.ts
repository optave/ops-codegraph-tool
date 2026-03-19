import type { Repository, User } from './types';

export class UserRepository implements Repository<User> {
  private store: Map<string, User> = new Map();

  findById(id: string): User | null {
    return this.store.get(id) ?? null;
  }

  save(user: User): void {
    this.store.set(user.id, user);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }
}

export function createRepository(): Repository<User> {
  return new UserRepository();
}
