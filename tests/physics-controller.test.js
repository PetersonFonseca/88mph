import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Vector3 } from 'three';
import { CarController } from '../src/car/carController.js';
import { moveCircle } from '../src/core/collision.js';

test('exiting below the speed tolerance parks the vehicle completely', () => {
  const car = new CarController(new Scene());
  car.enter();
  car.physics.setSpeedMph(1.5);
  const walker = { position: new Vector3(), yaw: 0, pitch: 0 };
  assert.equal(car.exit(walker, []), true);
  assert.equal(car.physics.speed, 0);
  assert.equal(car.occupied, false);
  assert.equal(car.doorOpen, true);
  assert.equal(walker.position.y, 1.7);
  car.model.dispose();
});

test('blocked exits keep the player inside the car', () => {
  const car = new CarController(new Scene());
  car.physics.reset({ x: 0, z: 0, yaw: 0 });
  car.sync();
  car.enter();
  const obstacle = [{ type: 'box', minX: -4, maxX: 4, minZ: -1, maxZ: 1 }];
  const walker = { position: new Vector3(10, 1.7, 10), yaw: 0, pitch: 0 };
  assert.equal(car.exit(walker, obstacle), false);
  assert.equal(car.occupied, true);
  assert.deepEqual(walker.position.toArray(), [10, 1.7, 10]);
  car.model.dispose();
});

test('walkers cannot cross the parked vehicle, including after its rotation', () => {
  const car = new CarController(new Scene());
  for (const yaw of [0, Math.PI / 2]) {
    car.physics.reset({ x: 0, z: 0, yaw });
    car.sync();
    const start = new Vector3(-4, 1.7, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw);
    const motion = new Vector3(8, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw);
    const result = moveCircle(start, motion.x, motion.z, 0.32, car.colliders);
    assert.equal(result.collided, true);
    const local = new Vector3(result.x, 0, result.z).applyAxisAngle(new Vector3(0, 1, 0), -yaw);
    assert.ok(local.x <= -1.17, `walker passed the vehicle at yaw=${yaw}`);
  }
  car.model.dispose();
});
