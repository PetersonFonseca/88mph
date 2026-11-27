import * as THREE from 'three';
import { createEra } from '../kit/environment.js';

export function build(ctx) {
  const w = createEra(ctx, 'future'), { kit, palette: p, lib } = w;
  const growth = Math.min(2.4, 1 + Math.max(0, ctx.date.year - 2077) / 1600);
  const names = ['NOVA AURORA', 'MEMÓRIA VIVA', 'ÓRBITA 88', 'ARQUIVO DO AMANHÃ', 'TRÂNSITO AÉREO', 'NEXO'];
  for (let i = 0; i < 17; i++) for (const side of [-1, 1]) {
    if (side === 1 && i <= 1) continue; // The full historical court remains a landing platform.
    const x = side * (24 + w.random() * 12), z = 24 - i * 31;
    const h = (20 + w.random() * 40) * growth, width = 15 + w.random() * 7;
    w.building({ x, z, w: width, d: 23, h, color: [0x203d50, 0x283249, 0x344452, 0x263c42][i % 4], name: names[i % names.length], neon: i % 2 ? '#ff83e3' : '#8ffaff', floors: Math.min(12, Math.floor(h / 4)) });
    for (const edge of [-1, 1]) kit.box(x - side * (width / 2 + .1), h / 2, z + edge * 10.5, .12, h - .4, .13, i % 3 === 0 ? p.pink : p.cyan);
    kit.box(x, h + 1.3, z, width * .6, 2.4, 15, p.metal);
  }
  // The old parking court is a landing platform, on the same footprint.
  for (const z of [-6, 35]) kit.box(19, .04, z, 22, .04, .13, p.cyan);
  kit.box(29.5, .04, 14.5, .13, .04, 41, p.cyan);
  kit.plane(23, .045, 17, 6, 6, lib.sign('H', '#74f9ff', '#0d2931', 180), [-Math.PI / 2, 0, 0]);
  for (const z of [-90, -210, -360]) {
    kit.cylinder(0, 17, z, 1.1, 50, p.chrome, 1.1, [0, 0, Math.PI / 2]);
    for (const x of [-23, 23]) kit.box(x, 8, z, .7, 16, .7, p.metal);
    kit.box(0, 16, z, 45, .15, .15, p.cyan);
  }
  for (let i = 0; i < 12; i++) {
    const vehicle = new THREE.Group();
    const body = kit.dynamic(new THREE.BoxGeometry(2, .55, 4), p.chrome); vehicle.add(body);
    for (const x of [-.8, .8]) { const thruster = kit.dynamic(new THREE.BoxGeometry(.23, .15, 3.4), i % 2 ? p.pink : p.cyan); thruster.position.set(x, -.35, 0); vehicle.add(thruster); }
    w.group.add(vehicle);
    const direction = i % 2 ? -1 : 1;
    w.animations.push((dt, t) => { vehicle.position.set(direction * (9 + i % 3 * 3), 14 + i % 4 * 4 + Math.sin(t + i) * .3, ((i * 73 + t * (13 + i) * direction + 1800) % 1100) - 550); vehicle.rotation.y = direction < 0 ? 0 : Math.PI; });
  }
  // Autonomous drones orbit the landmark platform.
  for (let i = 0; i < 3; i++) {
    const drone = kit.dynamic(new THREE.OctahedronGeometry(.45), p.cyan);
    w.animations.push((dt, t) => { drone.position.set(20 + Math.cos(t * .3 + i * 2) * 12, 7 + Math.sin(t + i), 16 + Math.sin(t * .3 + i * 2) * 12); drone.rotation.y = t; });
  }
  return w.finish();
}
