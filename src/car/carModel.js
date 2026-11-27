import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A complete, original mesh built in metres. The nose points toward local -Z.
export function createCarModel({ style = 'time', color = 0xa8b8bf } = {}) {
  const group = new THREE.Group();
  group.name = 'Máquina do tempo';
  const staticParts = new THREE.Group();
  group.add(staticParts);
  const materials = {
    steel: new THREE.MeshStandardMaterial({ color, metalness: 0.88, roughness: 0.31 }),
    edge: new THREE.MeshStandardMaterial({ color: 0x667982, metalness: 0.9, roughness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x121c21, metalness: 0.25, roughness: 0.58 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x090d11, roughness: 0.88 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe1eef3, metalness: 0.95, roughness: 0.18 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x152b37, metalness: 0.65, roughness: 0.14, side: THREE.DoubleSide }),
    blue: new THREE.MeshStandardMaterial({ color: 0x2498bc, emissive: 0x29c8ff, emissiveIntensity: 2.0, roughness: 0.22, metalness: 0.5 }),
    white: new THREE.MeshStandardMaterial({ color: 0xffe5bb, emissive: 0xffd59b, emissiveIntensity: 1.8 }),
    red: new THREE.MeshStandardMaterial({ color: 0x731c17, emissive: 0xff2113, emissiveIntensity: 1.6 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xd76c18, emissive: 0xff6600, emissiveIntensity: 1.5 }),
    wireRed: new THREE.MeshStandardMaterial({ color: 0xaa291b, roughness: 0.4 }),
    wireYellow: new THREE.MeshStandardMaterial({ color: 0xcfa62a, roughness: 0.45 }),
  };

  function mesh(geometry, material, parent = staticParts) {
    const object = new THREE.Mesh(geometry, material);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function box(w, h, d, x, y, z, material, parent) {
    const object = mesh(new THREE.BoxGeometry(w, h, d), material, parent);
    object.position.set(x, y, z);
    return object;
  }
  function cylinder(radius, length, x, y, z, material, parent, radial = 12) {
    const object = mesh(new THREE.CylinderGeometry(radius, radius, length, radial), material, parent);
    object.position.set(x, y, z);
    return object;
  }
  function polygon(vertices, material, parent) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    for (let index = 1; index < vertices.length - 1; index++) {
      positions.push(...vertices[0], ...vertices[index], ...vertices[index + 1]);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return mesh(geometry, material, parent);
  }
  function tube(points, radius, material, parent = staticParts) {
    const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
    return mesh(new THREE.TubeGeometry(curve, Math.max(10, points.length * 5), radius, 6, false), material, parent);
  }
  function sectionBody() {
    const sections = [
      [-2.24, 0.89, 0.4, 0.68], [-1.68, 0.97, 0.33, 0.79],
      [-0.93, 0.98, 0.32, 0.86], [-0.7, 0.98, 0.32, 0.57],
      [0.99, 0.99, 0.33, 0.57], [1.43, 0.98, 0.34, 0.84],
      [1.74, 0.95, 0.36, 0.81], [2.16, 0.9, 0.43, 0.75],
    ];
    const vertices = [];
    for (const [z, width, bottom, top] of sections) {
      vertices.push([-width, bottom, z], [width, bottom, z], [width, top, z], [-width, top, z]);
    }
    const positions = [];
    function tri(a, b, c) { positions.push(...vertices[a], ...vertices[b], ...vertices[c]); }
    for (let i = 0; i < sections.length - 1; i++) {
      for (let k = 0; k < 4; k++) {
        const a = i * 4 + k;
        const b = i * 4 + (k + 1) % 4;
        const c = (i + 1) * 4 + (k + 1) % 4;
        const d = (i + 1) * 4 + k;
        tri(a, b, d); tri(b, c, d);
      }
    }
    tri(0, 2, 1); tri(0, 3, 2);
    const last = vertices.length - 4;
    tri(last, last + 1, last + 2); tri(last, last + 2, last + 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    mesh(geo, materials.steel);
  }
  sectionBody();
  box(1.9, 0.17, 4.12, 0, 0.37, -0.01, materials.dark);
  box(1.83, 0.15, 0.1, 0, 0.48, -2.27, materials.dark);
  box(1.88, 0.035, 0.11, 0, 0.57, -2.29, materials.chrome);
  box(1.82, 0.16, 0.13, 0, 0.49, 2.19, materials.dark);
  // Long, low hood with sharp brushed-steel creases.
  for (const side of [-1, 1]) {
    tube([[side * 0.66, 0.694, -2.2], [side * 0.72, 0.808, -1.65], [side * 0.75, 0.868, -0.94]], 0.009, materials.chrome);
    box(0.018, 0.05, 3.84, side * 0.995, 0.55, -0.02, materials.dark);
  }
  box(0.87, 0.19, 0.055, 0, 0.68, -2.268, materials.dark);
  for (let line = 0; line < 6; line++) {
    box(0.85, 0.011, 0.018, 0, 0.605 + line * 0.028, -2.302, materials.edge);
  }
  for (const side of [-1, 1]) {
    for (let lamp = 0; lamp < 2; lamp++) {
      const x = side * (0.52 + lamp * 0.23);
      box(0.226, 0.2, 0.06, x, 0.68, -2.27, materials.dark);
      box(0.187, 0.157, 0.062, x, 0.68, -2.308, materials.white);
      for (let rib = -1; rib <= 1; rib++) {
        box(0.007, 0.144, 0.006, x + rib * 0.047, 0.68, -2.342, materials.chrome);
      }
    }
    box(0.19, 0.065, 0.05, side * 0.73, 0.46, -2.33, materials.orange);
    box(0.38, 0.12, 0.06, side * 0.66, 0.68, 2.185, materials.red);
    box(0.1, 0.12, 0.06, side * 0.88, 0.68, 2.19, materials.orange);
  }
  box(0.4, 0.105, 0.025, 0, 0.59, 2.267, materials.chrome);
  box(0.29, 0.066, 0.029, 0, 0.59, 2.283, materials.dark);

  // Sloped windscreen and rear glass sit between the two gullwing doors.
  polygon([[-0.88, 0.86, -0.91], [0.88, 0.86, -0.91], [0.62, 1.39, -0.27], [-0.62, 1.39, -0.27]], materials.glass);
  box(1.23, 0.065, 1.03, 0, 1.4, 0.23, materials.steel);
  polygon([[-0.62, 1.39, 0.74], [0.62, 1.39, 0.74], [0.88, 0.88, 1.47], [-0.88, 0.88, 1.47]], materials.glass);
  for (const side of [-1, 1]) {
    tube([[side * 0.9, 0.86, -0.92], [side * 0.63, 1.42, -0.28], [side * 0.63, 1.42, 0.75], [side * 0.9, 0.87, 1.49]], 0.034, materials.steel);
  }
  // Rear window louvres.
  for (let i = 0; i < 7; i++) {
    const z = 0.85 + i * 0.082;
    const y = 1.34 - i * 0.057;
    const slat = box(1.24 + i * 0.04, 0.035, 0.08, 0, y, z, materials.dark);
    slat.rotation.x = -0.5;
  }

  const doors = [];
  for (const side of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(side * 0.59, 1.4, 0.2);
    group.add(hinge);
    const local = (x, y, z) => [x - hinge.position.x, y - hinge.position.y, z - hinge.position.z];
    const door = new THREE.Group();
    hinge.add(door);
    const outsideX = side * 0.997;
    const doorPanel = [
      local(outsideX, 0.57, -0.72), local(outsideX, 0.57, 0.97),
      local(outsideX, 0.88, 0.97), local(outsideX, 0.88, -0.72),
    ];
    polygon(side > 0 ? doorPanel.reverse() : doorPanel, materials.steel, door);
    polygon([
      local(side * 0.962, 0.9, -0.73), local(side * 0.962, 0.9, 0.97),
      local(side * 0.628, 1.37, 0.71), local(side * 0.628, 1.37, -0.25),
    ], materials.glass, door);
    const seam = [[outsideX, 0.57, -0.73], [outsideX, 0.9, -0.73], [side * 0.63, 1.4, -0.26], [side * 0.63, 1.4, 0.73], [outsideX, 0.9, 0.99], [outsideX, 0.57, 0.99]];
    tube(seam.map((point) => local(...point)), 0.018, materials.edge, door);
    tube([[side * 0.97, 0.91, -0.72], [side * 0.97, 0.91, 0.96]].map((point) => local(...point)), 0.018, materials.chrome, door);
    const handlePosition = local(side * 1.01, 0.83, 0.7);
    box(0.045, 0.04, 0.17, ...handlePosition, materials.dark, door);
    const mirrorPosition = local(side * 1.08, 0.98, -0.59);
    box(0.2, 0.11, 0.19, ...mirrorPosition, materials.dark, door);
    const mirrorGlass = local(side * 1.09, 0.98, -0.49);
    box(0.17, 0.075, 0.012, ...mirrorGlass, materials.chrome, door);
    doors.push({ hinge, side });
  }
  // Dark seats remain visible with the door raised.
  box(1.57, 0.15, 0.29, 0, 0.81, -0.65, materials.dark);
  const steeringWheel = mesh(new THREE.TorusGeometry(0.19, 0.025, 7, 20), materials.dark);
  steeringWheel.position.set(-0.43, 0.98, -0.36);
  steeringWheel.rotation.x = -0.35;
  for (const side of [-1, 1]) {
    box(0.52, 0.14, 0.63, side * 0.42, 0.66, 0.2, materials.dark);
    const seat = box(0.48, 0.5, 0.17, side * 0.42, 0.88, 0.56, materials.dark);
    seat.rotation.x = -0.12;
  }

  const wheels = [];
  for (const side of [-1, 1]) {
    for (const axle of [-1.4, 1.42]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.99, 0.39, axle);
      group.add(pivot);
      const wheel = new THREE.Group();
      pivot.add(wheel);
      const tire = cylinder(0.385, 0.28, 0, 0, 0, materials.rubber, wheel, 24);
      tire.rotation.z = Math.PI / 2;
      const rim = cylinder(0.283, 0.285, 0, 0, 0, materials.edge, wheel, 24);
      rim.rotation.z = Math.PI / 2;
      const hub = cylinder(0.083, 0.308, 0, 0, 0, materials.chrome, wheel, 12);
      hub.rotation.z = Math.PI / 2;
      const ring = mesh(new THREE.TorusGeometry(0.277, 0.019, 5, 24), materials.chrome, wheel);
      ring.rotation.y = Math.PI / 2;
      ring.position.x = side * 0.151;
      for (let spoke = 0; spoke < 16; spoke++) {
        const angle = spoke / 16 * Math.PI * 2;
        const fin = box(0.015, 0.019, 0.19, side * 0.152, Math.sin(angle) * 0.17, Math.cos(angle) * 0.17, materials.chrome, wheel);
        fin.rotation.x = -angle + 0.1;
      }
      wheels.push({ pivot, wheel, front: axle < 0 });
      // The metal wheel arch is an actual half ring, not a painted texture.
      const arch = mesh(new THREE.TorusGeometry(0.45, 0.026, 5, 16, Math.PI), materials.edge);
      arch.rotation.y = Math.PI / 2;
      arch.position.set(side * 1.015, 0.4, axle);
    }
  }

  if (style === 'time') {
    // External field coils trace the body; layered cables keep the machinery legible.
    for (const side of [-1, 1]) {
      const rail = [
        [side * 1.055, 0.56, -1.8], [side * 1.07, 0.96, -1.44],
        [side * 1.065, 1.01, -1.07], [side * 1.06, 0.58, -0.65],
        [side * 1.06, 0.54, 0.9], [side * 1.065, 0.96, 1.4],
        [side * 0.86, 1.19, 1.84], [side * 0.75, 1.19, 2.09],
      ];
      tube(rail, 0.066, materials.dark);
      tube(rail.map(([x, y, z]) => [x + side * 0.013, y + 0.047, z]), 0.019, materials.blue);
      tube(rail.map(([x, y, z]) => [x + side * 0.045, y - 0.033, z]), 0.013, materials.wireRed);
      tube(rail.map(([x, y, z]) => [x + side * 0.047, y - 0.066, z]), 0.012, materials.wireYellow);
      for (const z of [-1.56, -0.78, 0.5, 1.49]) {
        box(0.13, 0.15, 0.075, side * 1.07, z < -1 ? 0.85 : z > 1 ? 0.99 : 0.59, z, materials.chrome);
      }
      box(0.43, 0.36, 0.55, side * 0.6, 1.02, 1.75, materials.dark);
      const vent = box(0.49, 0.045, 0.65, side * 0.6, 1.22, 1.73, materials.edge);
      vent.rotation.x = 0.25;
      for (let i = 0; i < 6; i++) {
        box(0.41, 0.04, 0.035, side * 0.6, 1.25 - i * 0.015, 1.44 + i * 0.085, materials.chrome);
      }
      const canister = cylinder(0.1, 0.51, side * 0.65, 1.12, 1.2, materials.chrome);
      canister.rotation.x = Math.PI / 2;
      for (let band = 0; band < 5; band++) {
        const ring = mesh(new THREE.TorusGeometry(0.105, 0.015, 5, 12), materials.dark);
        ring.position.set(side * 0.65, 1.12, 1.01 + band * 0.09);
      }
    }
    box(0.52, 0.3, 0.55, 0, 1.0, 1.68, materials.edge);
    const reactor = cylinder(0.19, 0.41, 0.08, 1.35, 1.52, materials.chrome);
    reactor.rotation.z = -0.08;
    cylinder(0.22, 0.055, 0.06, 1.57, 1.52, materials.dark);
    cylinder(0.16, 0.04, 0.06, 1.61, 1.52, materials.chrome);
    tube([[-0.65, 1.2, 1.2], [-0.34, 1.46, 1.1], [0.38, 1.47, 1.13], [0.66, 1.2, 1.27]], 0.045, materials.edge);
    tube([[-0.65, 1.23, 1.22], [-0.34, 1.51, 1.12], [0.38, 1.51, 1.15], [0.66, 1.23, 1.29]], 0.016, materials.blue);
  }

  // A transparent procedural contact shadow anchors the vehicle on wet asphalt.
  const shadowGeometry = new THREE.PlaneGeometry(2.4, 4.8);
  const shadowMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {},
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec2 vUv; void main(){vec2 p=abs(vUv-.5)*2.;float a=(1.-smoothstep(.4,1.,p.x))*(1.-smoothstep(.5,1.,p.y));gl_FragColor=vec4(.005,.009,.013,a*.5);}',
  });
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.017;
  shadow.renderOrder = 1;
  group.add(shadow);

  // Keep the detailed vehicle cheap: combine immobile pieces by material.
  function mergeChildren(parent) {
    const batches = new Map();
    for (const object of [...parent.children]) {
      if (!object.isMesh) continue;
      object.updateMatrix();
      let geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      geometry.applyMatrix4(object.matrix);
      // All primitives now share the position/normal attributes used by lighting.
      geometry.deleteAttribute('uv');
      if (!batches.has(object.material)) batches.set(object.material, []);
      batches.get(object.material).push(geometry);
      object.geometry.dispose();
      parent.remove(object);
    }
    for (const [material, pieces] of batches) {
      const combined = mergeGeometries(pieces, false);
      if (combined) mesh(combined, material, parent);
      pieces.forEach((geometry) => geometry.dispose());
    }
  }
  mergeChildren(staticParts);
  doors.forEach(({ hinge }) => mergeChildren(hinge.children[0]));
  wheels.forEach(({ wheel }) => mergeChildren(wheel));

  let doorAngle = 0;
  let wheelRotation = 0;
  return {
    group,
    update(dt, { speed = 0, steer = 0, doorOpen = false, charge = 0, brake = false } = {}) {
      doorAngle = THREE.MathUtils.damp(doorAngle, doorOpen ? 1.28 : 0, 5.5, dt);
      // Only the driver's door opens during play; the other remains a real pivot.
      doors[0].hinge.rotation.z = -doorAngle;
      wheelRotation += speed * dt / 0.385;
      wheels.forEach(({ wheel, pivot, front }) => {
        wheel.rotation.x = -wheelRotation;
        pivot.rotation.y = front ? steer * 0.34 : 0;
      });
      materials.blue.emissiveIntensity = .9 + Math.max(0, charge) * 3.6;
      materials.red.emissiveIntensity = brake ? 2.5 : .8;
    },
    dispose() {
      const geometries = new Set();
      group.traverse((object) => { if (object.geometry) geometries.add(object.geometry); });
      geometries.forEach((geometry) => geometry.dispose());
      Object.values(materials).forEach((material) => material.dispose());
      shadowMaterial.dispose();
      group.removeFromParent();
    },
  };
}
