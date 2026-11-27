export const layout = Object.freeze({
  roadWidth: 14, roadLength: 1200, roadMin: -600, roadMax: 600,
  yard: { minX: 7, maxX: 30, minZ: -7, maxZ: 36 },
  waterTower: { x: 48, z: -56 }, landmarkTree: { x: -16, z: 24 },
});
export function surfaceAt(x, z, era = 'present') {
  if (Math.abs(x) < 7 && Math.abs(z) <= 600) return 'road';
  if (x >= 7 && x <= 30 && z >= -7 && z <= 36) return era === 'oldwest' ? 'dirt' : 'road';
  return era === 'oldwest' ? 'dirt' : 'grass';
}

