// Callback pattern fixture — tests callback and higher-order edges
import type { User } from './types';

export type UserProcessor = (user: User) => void;
export type UserPredicate = (user: User) => boolean;

export function processEach(users: User[], fn: UserProcessor): void {
  for (const user of users) {
    fn(user);
  }
}

export function filterThen(users: User[], pred: UserPredicate, fn: UserProcessor): void {
  for (const user of users) {
    if (pred(user)) fn(user);
  }
}

export function logUser(user: User): void {
  console.log(user.name);
}

export function upperUser(user: User): void {
  console.log(user.name.toUpperCase());
}

export function hasEmail(user: User): boolean {
  return user.email.length > 0;
}

export function runCallbackDemo(users: User[]): void {
  processEach(users, logUser);
  processEach(users, upperUser);
  filterThen(users, hasEmail, logUser);
}
