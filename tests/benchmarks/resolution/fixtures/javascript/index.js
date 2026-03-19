import { buildService, UserService } from './service.js';
import { validate } from './validators.js';

export function main() {
  const svc = buildService();
  const result = svc.createUser({ name: 'Alice' });
  if (result && validate(result)) {
    svc.deleteUser(1);
  }
}

export function directInstantiation() {
  const svc = new UserService();
  return svc.createUser({ name: 'Bob' });
}
