// All collision shapes live on the X/Z ground plane. Heights are visual only.
const EPSILON = 0.0001;

function penetration(x, z, radius, shape) {
  if (shape.type === 'circle') {
    const dx = x - shape.x;
    const dz = z - shape.z;
    const distance = Math.hypot(dx, dz);
    const overlap = radius + shape.radius - distance;
    if (overlap <= 0) return null;
    if (distance < EPSILON) return { x: overlap + EPSILON, z: 0 };
    return { x: dx / distance * (overlap + EPSILON), z: dz / distance * (overlap + EPSILON) };
  }
  if (shape.type !== 'box') return null;
  const nearX = Math.max(shape.minX, Math.min(shape.maxX, x));
  const nearZ = Math.max(shape.minZ, Math.min(shape.maxZ, z));
  const dx = x - nearX;
  const dz = z - nearZ;
  const distance = Math.hypot(dx, dz);
  if (distance >= radius) return null;
  if (distance > EPSILON) {
    const overlap = radius - distance + EPSILON;
    return { x: dx / distance * overlap, z: dz / distance * overlap };
  }
  // A center inside a box must leave through its nearest edge.
  const sides = [
    { distance: x - shape.minX, x: shape.minX - radius - EPSILON - x, z: 0 },
    { distance: shape.maxX - x, x: shape.maxX + radius + EPSILON - x, z: 0 },
    { distance: z - shape.minZ, x: 0, z: shape.minZ - radius - EPSILON - z },
    { distance: shape.maxZ - z, x: 0, z: shape.maxZ + radius + EPSILON - z },
  ];
  sides.sort((a, b) => a.distance - b.distance);
  return sides[0];
}

export function isFree(x, z, radius, colliders = []) {
  return !colliders.some((shape) => penetration(x, z, radius, shape));
}

export function resolveCircle(x, z, radius, colliders = []) {
  let collided = false;
  for (let iteration = 0; iteration < 4; iteration++) {
    let corrected = false;
    for (const shape of colliders) {
      const push = penetration(x, z, radius, shape);
      if (!push) continue;
      x += push.x;
      z += push.z;
      corrected = collided = true;
    }
    if (!corrected) break;
  }
  return { x, z, collided };
}

export function moveCircle(position, dx, dz, radius, colliders = []) {
  // Short spatial steps prevent tunnelling through narrow fences at any frame rate.
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / Math.max(0.08, radius * 0.5)));
  let x = position.x;
  let z = position.z;
  let collided = false;
  for (let step = 0; step < steps; step++) {
    const result = resolveCircle(x + dx / steps, z + dz / steps, radius, colliders);
    x = result.x;
    z = result.z;
    collided ||= result.collided;
  }
  return { x, z, collided };
}
