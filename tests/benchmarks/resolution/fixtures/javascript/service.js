import { Logger } from './logger.js';
import { normalize, validate } from './validators.js';

export class UserService {
  constructor() {
    this.logger = new Logger('UserService');
  }

  createUser(data) {
    const clean = normalize(data);
    if (!validate(clean)) {
      this.logger.error('Validation failed');
      return null;
    }
    this.logger.info('User created');
    return clean;
  }

  deleteUser(id) {
    this.logger.warn(`Deleting user ${id}`);
    return true;
  }
}

export function buildService() {
  return new UserService();
}
