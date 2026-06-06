// Barrel consumer — imports via barrel.ts to test re-export resolution
import { createRepository, createService } from './barrel';

export function initFromBarrel(): void {
  const svc = createService();
  createRepository();
  svc.addUser('{"id":"3","name":"Carol","email":"c@d.com"}');
  const result = svc.getUser('3');
  if (result) {
    svc.removeUser('3');
  }
}
