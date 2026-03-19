import { createRepository } from './repository';
import { JsonSerializer } from './serializer';
import type { Repository, Serializer, User } from './types';

export class UserService {
  private repo: Repository<User>;
  private serializer: Serializer<User>;

  constructor(repo: Repository<User>, serializer: Serializer<User>) {
    this.repo = repo;
    this.serializer = serializer;
  }

  getUser(id: string): string | null {
    const user = this.repo.findById(id);
    if (!user) return null;
    return this.serializer.serialize(user);
  }

  addUser(raw: string): void {
    const user = this.serializer.deserialize(raw);
    this.repo.save(user);
  }

  removeUser(id: string): boolean {
    return this.repo.delete(id);
  }
}

export function createService(): UserService {
  const repo = createRepository();
  const serializer = new JsonSerializer();
  return new UserService(repo, serializer);
}
