import test from 'node:test';
import assert from 'node:assert/strict';
import { CarPhysics, MPH_TO_MS } from '../src/car/carPhysics.js';
import { isFree, moveCircle } from '../src/core/collision.js';

function simulate(car, seconds, controls, surface = () => 'road', colliders = []) {
  for (let i = 0; i < Math.ceil(seconds * 120); i++) car.step(1 / 120, controls, surface, colliders);
}

test('reaches 88 mph on the road in approximately 11 seconds and 230 metres', () => {
  const car = new CarPhysics();
  car.reset({ z: 400 });
  let seconds = 0;
  while (car.speedMph < 88 && seconds < 20) {
    car.step(1 / 120, { throttle: 1 }, () => 'road', []);
    seconds += 1 / 120;
  }
  assert.ok(seconds > 10 && seconds < 12, `88 mph reached in ${seconds.toFixed(2)} s`);
  assert.ok(car.odometer > 200 && car.odometer < 250, `distance ${car.odometer.toFixed(2)} m`);
});

test('off-road speed remains below the travel threshold, including road departure', () => {
  const car = new CarPhysics();
  car.reset({ z: 580 });
  simulate(car, 16, { throttle: 1 }, () => 'grass');
  assert.ok(car.speedMph < 55);
  car.setSpeedMph(100);
  car.step(1 / 60, { throttle: 1 }, () => 'grass');
  assert.ok(car.speedMph < 55);
});

test('brakes stop without creeping backwards; S can then select reverse', () => {
  const car = new CarPhysics();
  car.reset({ z: 400, speed: 88 * MPH_TO_MS });
  simulate(car, 5, { brake: 1 });
  assert.equal(car.speed, 0);
  simulate(car, 2, { throttle: -1 });
  assert.ok(car.speed < -2);
  simulate(car, 2, { handbrake: true });
  assert.equal(car.speed, 0);
});

test('swept circle cannot tunnel through a thin box and slides along its face', () => {
  const wall = [{ type: 'box', minX: -3, maxX: 3, minZ: -0.1, maxZ: 0.1 }];
  const result = moveCircle({ x: 0, z: 3 }, 1, -12, 0.35, wall);
  assert.ok(result.collided);
  assert.ok(result.z >= 0.449);
  assert.ok(result.x > 0.9);
  assert.ok(isFree(result.x, result.z, 0.35, wall));
});

test('three-circle car body stops at obstacles at high speed', () => {
  const wall = [{ type: 'box', minX: -10, maxX: 10, minZ: -0.1, maxZ: 0.1 }];
  const car = new CarPhysics();
  car.reset({ z: 12, speed: 88 * MPH_TO_MS });
  simulate(car, 1, { throttle: 1 }, () => 'road', wall);
  assert.ok(car.position.z >= 2.33, `car at z=${car.position.z}`);
  assert.ok(car.speedMph < 1);
});

test('steering reverses direction in reverse and never rotates a stopped car', () => {
  const car = new CarPhysics();
  car.reset();
  simulate(car, 1, { steer: 1 });
  assert.equal(car.yaw, 0);
  car.speed = 3;
  simulate(car, 0.4, { steer: 1 });
  assert.ok(car.yaw > 0);
  car.reset({ speed: -3 });
  simulate(car, 0.4, { steer: 1 });
  assert.ok(car.yaw < 0);
});
