import { Vehicle } from './Vehicle.js';

export class Car extends Vehicle {
  model: string;

  constructor(make: string, model: string) {
    // super-dispatch: bare super(...) resolves to Vehicle.constructor via parents map (#1929).
    super(make);
    this.model = model;
  }
}
