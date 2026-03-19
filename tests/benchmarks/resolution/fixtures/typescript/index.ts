import { JsonSerializer } from './serializer';
import { createService, UserService } from './service';

export function main(): void {
  const svc = createService();
  svc.addUser('{"id":"1","name":"Alice","email":"a@b.com"}');
  const result = svc.getUser('1');
  if (result) {
    svc.removeUser('1');
  }
}

export function withExplicitType(): string | null {
  const serializer: JsonSerializer = new JsonSerializer();
  const svc: UserService = createService();
  const raw = serializer.serialize({ id: '2', name: 'Bob', email: 'b@c.com' });
  svc.addUser(raw);
  return svc.getUser('2');
}
