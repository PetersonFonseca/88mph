import * as THREE from 'three';
import { createEra } from '../kit/environment.js';
import { canvasTexture } from '../materials.js';

export function build(ctx) {
  const w = createEra(ctx, 'fifties'), { kit, palette: p, lib } = w;
  const names = ['CINEMA ESTRELA', 'BARBEARIA', 'BANCO DA PRAÇA', 'RÁDIO & DISCOS', 'MERCADO CENTRAL', 'HOTEL AURORA'];
  const colors = [0x7f4c46, 0x47746f, 0x8d876c, 0x5c6b82, 0x977453, 0x845d65];
  for (let i = 0; i < 12; i++) for (const side of [-1, 1]) {
    if (side === 1 && i <= 2) continue; // Keep the court clear and leave room for the diner.
    w.building({ x: side * 22, z: 25 - i * 28, w: 17, d: 22, h: 7 + (i % 3) * 2, color: colors[i % colors.length], name: names[i % names.length], neon: i % 2 ? '#9cf5ee' : '#ffb9bb', floors: 2 });
  }
  w.building({ x: 28, z: -23, w: 27, d: 20, h: 5.8, color: 0x73918b, name: 'LANCHONETE 55', neon: '#ffb4c6', floors: 1 });
  kit.box(13.6, 3.3, -23, .18, .2, 21, p.pink);
  for (const dz of [-31, -27, -19, -15]) kit.box(13.55, 1.9, dz, .12, 2.2, 2.2, p.window);
  // A rotating red/white barber pole remains a visible landmark on foot.
  const barberPole = new THREE.Group(); barberPole.position.set(-12.9, 2.7, -3);
  for (let i = 0; i < 8; i++) {
    const mesh = kit.dynamic(new THREE.CylinderGeometry(.19, .19, .14, 12), i % 2 ? p.white : p.pink);
    mesh.position.y = (i - 3.5) * .14; barberPole.add(mesh);
  }
  w.group.add(barberPole); w.animations.push((dt, t) => { barberPole.rotation.y = t * 2; barberPole.rotation.z = Math.sin(t * 2) * .06; });
  // Marquee bulbs switch by scale without introducing or removing lights.
  const bulbs = [];
  for (let i = 0; i < 24; i++) {
    const bulb = kit.dynamic(new THREE.SphereGeometry(.09, 5, 4), p.warm);
    bulb.position.set(-13.32, 6.5, 15 + i * .85); bulbs.push(bulb);
  }
  w.animations.push((dt, t) => bulbs.forEach((b, i) => b.scale.setScalar(((Math.floor(t * 6) + i) % 4) === 0 ? .4 : 1)));
  for (let i = 0; i < 4; i++) w.parkedCar(24, -1 + i * 8.8, [0xb45b5d, 0x54a3a1, 0xb4c3b2, 0xc5ad66][i], true);
  w.building({ x: -25, z: 76, h: 4.5, w: 16, d: 12, color: 0xb4aaa1, name: 'POSTO RELÂMPAGO', neon: '#ffdc94', floors: 1 });
  for (const z of [70, 77]) { kit.box(-12, 1, z, 1.3, 2, 1.1, p.white); kit.box(-12, 1.4, z, 1.4, .6, 1.2, p.pink); }
  // Clock on the bank follows the selected local hour.
  const clockTexture = canvasTexture(256, 128, (c, width, height) => {
    c.fillStyle = '#1f2d35'; c.fillRect(0, 0, width, height); c.fillStyle = '#ffe6ac'; c.font = 'bold 70px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(`${String(ctx.date.hour).padStart(2, '0')}:${String(ctx.date.minute).padStart(2, '0')}`, width / 2, height / 2);
  });
  const clock = new THREE.MeshStandardMaterial({ map: clockTexture, emissiveMap: clockTexture, emissive: 0xffffff, emissiveIntensity: .65 });
  w.owned.push(clockTexture, clock);
  kit.plane(-13.4, 8.1, -31, 2.8, 1.2, clock, [0, Math.PI / 2, 0]);
  return w.finish();
}
