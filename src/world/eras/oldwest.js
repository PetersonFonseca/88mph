import * as THREE from 'three';
import { createEra } from '../kit/environment.js';

export function build(ctx) {
  const w = createEra(ctx, 'oldwest'), { kit, palette: p, lib } = w;
  const names = ['SALOON', 'XERIFE', 'ARMAZÉM', 'BANCO', 'HOTEL DO VALE', 'FERREIRO', 'ESTÁBULO'];
  for (let i = 0; i < 11; i++) for (const side of [-1, 1]) {
    if (side === 1 && i <= 1) continue; // Preserve the shared arrival court.
    const h = i % 3 === 0 ? 8 : 5.5;
    w.building({ x: side * 23, z: 22 - i * 25, w: 15, d: 18, h, color: [0x927048, 0x7c604a, 0x9f825b, 0x685244][i % 4], name: names[(i + (side > 0 ? 1 : 0)) % 7], neon: '#dfc995', wood: true, floors: h > 6 ? 2 : 1 });
  }
  for (let i = 0; i < 8; i++) {
    const tumbleweed = kit.dynamic(new THREE.IcosahedronGeometry(.5 + w.random() * .35, 1), lib.get('tumbleweed', { color: 0x98824d, wireframe: true }));
    const z = -40 - i * 27, start = w.random() * 30;
    w.animations.push((dt, t) => { tumbleweed.position.set(((start + t * .85) % 50) - 25, .8 + Math.abs(Math.sin(t * 2 + i)) * .2, z + Math.sin(t * .3 + i) * 2); tumbleweed.rotation.z = -t; });
  }
  const windmill = new THREE.Group(); windmill.position.set(-34, 12, 72);
  kit.box(-34, 5.7, 72, .6, 11.4, .6, p.darkWood);
  for (let i = 0; i < 8; i++) {
    const blade = kit.dynamic(new THREE.BoxGeometry(.8, 3.4, .12), p.chrome);
    const angle = i * Math.PI / 4; blade.position.set(Math.sin(angle) * 2, Math.cos(angle) * 2, 0); blade.rotation.z = -angle; windmill.add(blade);
  }
  w.group.add(windmill); w.animations.push((dt, t) => { windmill.rotation.z = t * .45; });
  // Hitching posts, barrels and a wagon give the town a human scale.
  for (const z of [-18, -42, -68, 51]) {
    for (const dz of [-1.3, 1.3]) kit.box(-10.5, .7, z + dz, .16, 1.4, .16, p.darkWood);
    kit.box(-10.5, 1.2, z, .16, .16, 3, p.wood);
    kit.cylinder(-12, .6, z + 4, .45, 1.2, p.wood);
  }
  kit.box(24, 1.1, 23, 2.4, .8, 4, p.wood);
  for (const side of [-1, 1]) for (const z of [21.6, 24.5]) kit.add(new THREE.TorusGeometry(.7, .09, 5, 16), p.darkWood, 24 + side * 1.3, .72, z, [0, Math.PI / 2, 0]);
  return w.finish();
}
