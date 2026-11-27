import * as THREE from 'three';
import { layout, surfaceAt } from '../layout.js';
import { WorldKit } from './geometry.js';
import { createWetRoad } from '../wetRoad.js';

export function createEra(ctx, era) {
  const { materials: lib, rng: random } = ctx;
  const group = new THREE.Group(); group.name = `Época: ${era}`;
  const kit = new WorldKit(group, lib), colliders = [], lamps = [], animations = [], owned = [];
  const old = era === 'oldwest', future = era === 'future';
  const palette = {
    metal: lib.get('dark-metal', { color: 0x26353d, metalness: .72, roughness: .38 }),
    chrome: lib.get('chrome', { color: 0x9aabb2, metalness: .8, roughness: .24 }),
    wood: lib.get('wood', { color: 0x805239 }), darkWood: lib.get('dark-wood', { color: 0x3e2b25 }),
    white: lib.get('ivory', { color: 0xc9d2cc }),
    // Bulbs emit a fixed radiance; their own nearby point light must not illuminate them.
    warm: lib.unlit('lamp-warm', 0xffd59b, 1.8),
    cool: lib.unlit('lamp-cool', 0x8feaff, 1.6),
    cyan: lib.get('neon-cyan', { color: 0x49efff, emissive: 0x15dfff, emissiveIntensity: 1.6 }),
    pink: lib.get('neon-pink', { color: 0xff60be, emissive: 0xff249a, emissiveIntensity: 1.4 }),
    window: lib.get('windows-warm', { color: 0xe5c89a, emissive: 0xffb44f, emissiveIntensity: .4 }),
    darkWindow: lib.get('windows-dark', { color: 0x122630, metalness: .6, roughness: .25 }),
    leaf: lib.get('leaves', { color: 0x244b3c }),
    trunk: lib.get('trunk', { color: 0x3d302b }),
    asphalt: lib.get('asphalt', { map: lib.roadTexture, color: 0x6a7b84, roughness: .24, metalness: .35 }),
    roadDry: lib.get('asphalt-dry', { map: lib.roadTexture, color: 0xa0a6a5, roughness: .92 }),
    sand: lib.get('desert', { color: 0xb99460 }),
  };
  const ground = lib.get(`ground-${era}`, { color: old ? 0x9c794b : future ? 0x10252c : 0x253d31 });
  kit.plane(0, -.045, 0, 1800, 1800, ground, [-Math.PI / 2, 0, 0]);
  const roadMat = old ? lib.get('dirt-road', { color: 0xc3a16e }) : future ? lib.get('future-road', { color: 0x11262d, roughness: .3, metalness: .4 }) : era === 'present' ? palette.asphalt : palette.roadDry;
  kit.plane(0, .008, 0, 14, 1200, roadMat, [-Math.PI / 2, 0, 0]);
  kit.plane(18.5, .01, 14.5, 23, 43, roadMat, [-Math.PI / 2, 0, 0]);
  if (!old) {
    const curb = lib.get(`curb-${era}`, { color: future ? 0x30444e : 0x77817b });
    for (const side of [-1, 1]) {
      for (let z = -570; z < 600; z += 30) {
        if (side === 1 && z > -10 && z < 40) continue;
        kit.box(side * 8.15, .1, z, 2.3, .2, 29.8, curb);
        kit.box(side * 6.7, .018, z, .13, .012, 29.9, future ? palette.cyan : palette.white);
      }
    }
    for (let z = -588; z < 600; z += 12) {
      kit.box(-.12, .022, z, .12, .016, future ? 8 : 4, future ? palette.cyan : lib.get('line-gold', { color: 0xb9aa6c }));
      kit.box(.12, .022, z, .12, .016, future ? 8 : 4, future ? palette.cyan : lib.get('line-gold', { color: 0xb9aa6c }));
    }
    for (let i = 0; i < 4; i++) kit.box(20, .03, i * 8 + 1, 14, .015, .1, palette.white);
  }
  // The silhouette and landmark locations stay identical across all four worlds.
  for (let i = 0; i < 22; i++) {
    const angle = i / 22 * Math.PI * 2, r = 670 + random() * 120, h = 90 + random() * 140;
    kit.add(new THREE.ConeGeometry(100 + random() * 110, h, old ? 4 : 6), lib.get(`mountain-${era}`, { color: old ? 0x81664c : 0x233541 }), Math.cos(angle) * r, h / 2 - 12, Math.sin(angle) * r);
  }

  function tree(x, z, scale = 1) {
    kit.cylinder(x, 2.1 * scale, z, .32 * scale, 4.2 * scale, palette.trunk, .2 * scale);
    for (let i = 0; i < 3; i++) kit.sphere(x + (i - 1) * 1.1 * scale, (5.4 + (i % 2)) * scale, z, 2.6 * scale, palette.leaf, [1, 1.1, 1]);
    colliders.push({ type: 'circle', x, z, radius: .42 * scale });
  }
  function cactus(x, z, scale = 1) {
    const cactusMat = lib.get('cactus', { color: 0x497052 });
    kit.cylinder(x, 1.7 * scale, z, .28 * scale, 3.4 * scale, cactusMat);
    kit.cylinder(x + .65 * scale, 1.9 * scale, z, .2 * scale, 1.4 * scale, cactusMat);
    kit.box(x + .35 * scale, 1.25 * scale, z, .9 * scale, .3 * scale, .3 * scale, cactusMat);
    colliders.push({ type: 'circle', x, z, radius: .5 * scale });
  }
  if (!old) tree(layout.landmarkTree.x, layout.landmarkTree.z, future ? 1.6 : era === 'fifties' ? .8 : 1.2);
  else tree(layout.landmarkTree.x, layout.landmarkTree.z, .55);
  for (let z = -570; z <= 570; z += 25) for (const side of [-1, 1]) {
    if (side === 1 && z > -20 && z < 50) continue;
    if (old) cactus(side * (25 + random() * 24), z + random() * 9, .7 + random() * .5);
    else if (!future || Math.abs(z) > 220) tree(side * (12 + random() * 3), z + random() * 4, .8 + random() * .35);
  }

  function lamp(x, z, color = 0xffd59b, height = 7.8) {
    const side = Math.sign(x), m = old ? palette.darkWood : palette.metal;
    kit.cylinder(x, height / 2, z, old ? .12 : .1, height, m);
    kit.box(x - side * .65, height, z, 1.5, .12, .12, m);
    kit.box(x - side * 1.25, height - .1, z, old ? .35 : .6, .16, .5, color === 0x8feaff ? palette.cool : palette.warm);
    lamps.push({ position: new THREE.Vector3(x - side * 1.25, height - .8, z), x: x - side * 1.25, y: height - .8, z, color, intensity: old ? 35 : future ? 80 : 65 });
  }
  for (let z = -580; z < 600; z += old ? 44 : 30) for (const side of [-1, 1]) lamp(side * 9.1, z + (side > 0 ? 15 : 0), future ? 0x8feaff : 0xffd59b, old ? 4.2 : 7.8);

  function building({ x, z, w = 13, d = 17, h = 9, color = 0x596773, name = '', neon = '#b8faff', wood = false, floors = 2 }) {
    const side = Math.sign(x), front = x - side * (w / 2 + .07);
    const wall = lib.get(`wall-${color}`, { color, roughness: wood ? .95 : .7, metalness: future ? .35 : 0 });
    kit.box(x, h / 2, z, w, h, d, wall);
    kit.box(x, h + .18, z, w + .6, .36, d + .6, wood ? palette.darkWood : palette.metal);
    if (wood) {
      for (let y = .5; y < h; y += .8) kit.box(front, y, z, .07, .04, d, palette.darkWood);
      kit.box(front - side * 1.2, .18, z, 2.5, .35, d + 1, palette.wood);
      for (const dz of [-d / 2 + .6, d / 2 - .6]) kit.box(front - side * 2.1, 1.7, z + dz, .14, 3.4, .14, palette.darkWood);
      kit.box(front - side * 1.2, 3.4, z, 3, .2, d + 1.5, palette.darkWood);
    }
    for (let floor = 0; floor < floors; floor++) for (let dz = -d / 2 + 2; dz < d / 2 - 1; dz += 3.4) {
      const y = 2 + floor * (h - 2) / Math.max(floors, 1);
      kit.box(front - side * .01, y, z + dz, .08, Math.min(1.9, h / floors - .5), 1.75, random() < .77 ? palette.window : palette.darkWindow);
      kit.box(front - side * .08, y, z + dz, .09, .06, 1.8, palette.metal);
    }
    kit.box(front - side * .1, 1.25, z, .13, 2.5, 1.5, palette.darkWindow);
    if (name) {
      kit.plane(front - side * .15, Math.min(h - .7, 4.8), z, Math.min(d - .6, 13), 2.2, lib.sign(name, neon, wood ? '#38291f' : '#13232d'), [0, -side * Math.PI / 2, 0]);
    }
    colliders.push({ type: 'box', minX: x - w / 2 - (wood ? 2.5 : 0), maxX: x + w / 2 + (wood ? 2.5 : 0), minZ: z - d / 2, maxZ: z + d / 2 });
    return { x, z, front, h, w, d, side };
  }

  function parkedCar(x, z, color = 0x6f91a3, vintage = false) {
    const body = lib.get(`parked-car-${color}`, { color, metalness: .65, roughness: .3 });
    kit.box(x, .68, z, 1.9, .7, vintage ? 5.3 : 4.4, body);
    kit.box(x, 1.2, z + .2, 1.65, .58, 2.25, palette.darkWindow);
    kit.box(x, 1.54, z + .2, 1.7, .12, 2.35, body);
    for (const sx of [-1, 1]) for (const dz of [-1.45, 1.45]) kit.cylinder(x + sx * .92, .4, z + dz, .4, .22, palette.metal, .4, [0, 0, Math.PI / 2]);
    if (vintage) for (const sx of [-1, 1]) kit.box(x + sx * .85, 1.2, z + 2, .14, .7, 1.2, body);
    kit.box(x, .7, z - (vintage ? 2.7 : 2.25), 1.6, .12, .08, palette.chrome);
    colliders.push({ type: 'box', minX: x - 1.05, maxX: x + 1.05, minZ: z - 2.8, maxZ: z + 2.8 });
  }

  function tower() {
    const { x, z } = layout.waterTower;
    const mat = old ? palette.wood : palette.metal;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      kit.box(x + sx * 2.5, 6, z + sz * 2.5, .35, 12, .35, mat);
      kit.box(x + sx * 2.5, 5, z, .18, .18, 7.2, mat, [Math.PI / 4, 0, 0]);
    }
    if (future) {
      kit.cylinder(x, 12, z, 4.5, 1, palette.chrome);
      const sphere = kit.dynamic(new THREE.IcosahedronGeometry(4, 2), lib.get('hologram', { color: 0x46eaff, emissive: 0x15ccff, emissiveIntensity: 1.5, wireframe: true, transparent: true, opacity: .65 }));
      sphere.position.set(x, 17, z); animations.push((dt, t) => { sphere.rotation.y = t * .15; sphere.position.y = 17 + Math.sin(t) * .35; });
    } else {
      kit.cylinder(x, 13, z, 4, 5, mat);
      kit.add(new THREE.ConeGeometry(4.4, 1.7, 12), mat, x, 16.35, z);
      if (!old) kit.sphere(x, 17.4, z, .2, lib.get('tower-red', { color: 0xff4a27, emissive: 0xff1c04, emissiveIntensity: 2.5 }));
      for (const y of [11, 13, 15]) kit.add(new THREE.TorusGeometry(4.02, .08, 4, 20), palette.metal, x, y, z, [Math.PI / 2, 0, 0]);
    }
    colliders.push({ type: 'circle', x, z, radius: 4.5 });
  }
  tower();
  let wet = null;
  if (era === 'present') { wet = createWetRoad(lamps); group.add(wet.group); owned.push(wet); }
  function finish() {
    kit.finish();
    return {
      group, colliders, lamps, era, date: { ...ctx.date }, ambience: era,
      surfaceAt: (x, z) => surfaceAt(x, z, era),
      update(dt, t) { for (const animate of animations) animate(dt, t); wet?.update(t); },
      dispose() { group.removeFromParent(); kit.dispose(); for (const resource of owned) resource.dispose(); },
    };
  }
  return { group, kit, palette, lib, random, colliders, lamps, animations, owned, tree, cactus, lamp, building, parkedCar, finish };
}
