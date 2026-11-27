import { MathUtils, Vector3 } from 'three';
import { moveCircle, resolveCircle } from '../core/collision.js';

export const MPH_TO_MS = 0.44704;
const BODY_RADIUS = 0.86;
const BODY_OFFSETS = [-1.38, 0, 1.38];

export class CarPhysics {
  constructor() {
    this.position = new Vector3(12, 0, 18);
    this.yaw = -0.65;
    this.speed = 0;
    this.steer = 0;
    this.braking = false;
    this.collided = false;
    this.odometer = 0;
    this.surface = 'road';
  }

  get speedMph() { return this.speed / MPH_TO_MS; }
  setSpeedMph(mph) { this.speed = MathUtils.clamp(Number(mph) || 0, -18, 105) * MPH_TO_MS; }
  getForward() { return new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  reset({ x = 0, z = 0, yaw = 0, speed = 0 } = {}) {
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.speed = speed;
    this.steer = 0;
    this.braking = false;
    this.collided = false;
  }

  step(dt, controls = {}, surfaceAt = () => 'road', colliders = []) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Do not simulate a background tab's accumulated time in one frame.
    dt = Math.min(dt, 0.15);
    const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / steps;
    const throttle = MathUtils.clamp(controls.throttle || 0, -1, 1);
    const steering = MathUtils.clamp(controls.steer || 0, -1, 1);
    const brake = MathUtils.clamp(Number(controls.brake) || 0, 0, 1);
    const handbrake = !!controls.handbrake;
    this.collided = false;
    this.braking = brake > 0 || handbrake || (throttle < 0 && this.speed > 0.3);

    for (let step = 0; step < steps; step++) {
      this.surface = surfaceAt(this.position.x, this.position.z);
      const onRoad = this.surface === 'road';
      const absoluteSpeed = Math.abs(this.speed);
      let acceleration = 0;
      if (throttle > 0) acceleration = (this.speed < -0.3 ? 8.5 : onRoad ? 4.3 : 3.0) * throttle;
      if (throttle < 0) acceleration = (this.speed > 0.3 ? 9.2 : 2.7) * throttle;
      const drag = (onRoad ? 0.2 : 1.4) + absoluteSpeed * 0.015 + absoluteSpeed ** 2 * 0.0003;
      const slowing = drag + brake * 13 + (handbrake ? 19 : 0);
      let nextSpeed = this.speed + acceleration * h;
      nextSpeed = Math.sign(nextSpeed) * Math.max(0, Math.abs(nextSpeed) - slowing * h);
      const maxSpeed = (onRoad ? 104 : 54) * MPH_TO_MS;
      this.speed = MathUtils.clamp(nextSpeed, -16 * MPH_TO_MS, maxSpeed);

      this.steer = MathUtils.damp(this.steer, steering, 7.5, h);
      const steeringAngle = this.steer * 0.52 / (1 + absoluteSpeed * 0.11);
      const yawRate = MathUtils.clamp(this.speed / 2.5 * Math.tan(steeringAngle), -1.05, 1.05);
      const previousYaw = this.yaw;
      this.yaw += yawRate * h * (handbrake ? 1.3 : 1);
      const forwardX = -Math.sin(this.yaw);
      const forwardZ = -Math.cos(this.yaw);
      const dx = forwardX * this.speed * h;
      const dz = forwardZ * this.speed * h;
      let x = this.position.x;
      let z = this.position.z;
      let hit = false;
      // All three body circles sweep the same translation. Correct the center
      // after each circle, then resolve the full body once more at the end.
      for (const offset of BODY_OFFSETS) {
        const cx = x + forwardX * offset;
        const cz = z + forwardZ * offset;
        const moved = moveCircle({ x: cx, z: cz }, dx, dz, BODY_RADIUS, colliders);
        if (moved.collided) {
          x += moved.x - cx - dx;
          z += moved.z - cz - dz;
          hit = true;
        }
      }
      x += dx;
      z += dz;
      for (const offset of BODY_OFFSETS) {
        const cx = x + forwardX * offset;
        const cz = z + forwardZ * offset;
        const solved = resolveCircle(cx, cz, BODY_RADIUS, colliders);
        x += solved.x - cx;
        z += solved.z - cz;
        hit ||= solved.collided;
      }
      if (hit) {
        this.yaw = previousYaw;
        this.speed *= 0.38;
        if (Math.abs(this.speed) < 0.3) this.speed = 0;
        this.collided = true;
      }
      // Horizon bounds keep the complete 1.2 km road explorable without falling.
      const boundedX = MathUtils.clamp(x, -170, 170);
      const boundedZ = MathUtils.clamp(z, -592, 592);
      if (boundedX !== x || boundedZ !== z) {
        this.speed = 0;
        this.collided = true;
      }
      this.odometer += Math.hypot(boundedX - this.position.x, boundedZ - this.position.z);
      this.position.set(boundedX, 0, boundedZ);
    }
  }
}
