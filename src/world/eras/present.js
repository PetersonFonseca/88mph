import { createEra } from '../kit/environment.js';

export function build(ctx) {
  const w = createEra(ctx, 'present'), { kit, palette: p, lib } = w;
  w.building({ x: -31, z: -36, w: 29, d: 30, h: 10, color: 0x68777e, name: 'INSTITUTO DO TEMPO', neon: '#bce9e6', floors: 2 });
  w.building({ x: 34, z: -18, w: 22, d: 17, h: 8, color: 0x5d6a67, name: 'OBSERVATÓRIO', floors: 2 });
  w.building({ x: -27, z: 48, w: 20, d: 23, h: 7, color: 0x6b655d, name: 'CAFÉ DA ESQUINA', neon: '#ffcc8c' });
  for (let i = 0; i < 11; i++) for (const side of [-1, 1]) {
    const z = -115 - i * 35;
    w.building({ x: side * (26 + w.random() * 5), z, w: 17 + w.random() * 5, d: 21, h: 6 + w.random() * 12, color: [0x4d626a, 0x687770, 0x535a69, 0x6d605d][i % 4], floors: 3 });
  }
  // Bus shelter, benches and road furniture frame the walk to the car.
  kit.box(-10.5, 2.7, 5, 2.5, .16, 6, p.metal);
  for (const dz of [-2.8, 2.8]) kit.box(-11.5, 1.35, 5 + dz, .12, 2.7, .12, p.chrome);
  kit.box(-11.5, 1.4, 5, .08, 2.1, 5.5, lib.get('bus-glass', { color: 0x476c78, transparent: true, opacity: .4, metalness: .7, roughness: .2 }));
  kit.box(-11, .65, 5, .7, .18, 4.5, p.wood);
  kit.plane(-11.4, 1.8, 3, 1.1, 1.7, lib.sign('LINHA 88', '#79eee3'), [0, Math.PI / 2, 0]);
  for (let i = 0; i < 4; i++) w.parkedCar(24, -4 + i * 9, [0x4c656c, 0x9a9b90, 0x424650, 0x6c3030][i]);
  for (const z of [-22, 72]) {
    kit.box(-12, .55, z, 1.1, .12, 3.6, p.wood); kit.box(-12.45, 1, z, .12, .8, 3.6, p.wood);
    for (const dz of [-1.3, 1.3]) kit.box(-12, .25, z + dz, .65, .5, .15, p.metal);
  }
  return w.finish();
}
