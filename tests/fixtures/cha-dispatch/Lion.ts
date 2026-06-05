import { Animal } from './Animal.js';

export class Lion extends Animal {
  speak(): string {
    // super-dispatch: CHA resolves super.speak() to Animal.speak via parents map.
    super.speak();
    return 'ROAR';
  }
}
