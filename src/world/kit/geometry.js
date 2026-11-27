import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Static geometry is merged by material in 120 m cells. Each era owns only its merged buffers.
export class WorldKit {
  constructor(group, materials) { this.group = group; this.materials = materials; this.batches = new Map(); this.owned = new Set(); }
  add(geometry, material, x = 0, y = 0, z = 0, rotation = null) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rotation || [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
    geometry.applyMatrix4(matrix);
    // All primitive attributes are normalized to indexed positions, normals and UVs.
    const key = `${material.uuid}:${Math.floor(z / 120)}`;
    if (!this.batches.has(key)) this.batches.set(key, { material, geometries: [] });
    this.batches.get(key).geometries.push(geometry); return geometry;
  }
  box(x, y, z, w, h, d, material, rotation) { return this.add(new THREE.BoxGeometry(w, h, d), material, x, y, z, rotation); }
  cylinder(x, y, z, radius, height, material, top = radius, rotation) { return this.add(new THREE.CylinderGeometry(top, radius, height, 8), material, x, y, z, rotation); }
  sphere(x, y, z, radius, material, scale = [1, 1, 1]) { const g = new THREE.IcosahedronGeometry(radius, 1); g.scale(...scale); return this.add(g, material, x, y, z); }
  plane(x, y, z, w, h, material, rotation = [0, 0, 0]) { return this.add(new THREE.PlaneGeometry(w, h), material, x, y, z, rotation); }
  finish() {
    for (const { material, geometries } of this.batches.values()) {
      const normalized = geometries.map(g => g.index ? g.toNonIndexed() : g);
      const merged = mergeGeometries(normalized, false);
      for (const g of new Set([...geometries, ...normalized])) g.dispose();
      if (!merged) continue;
      this.owned.add(merged); const mesh = new THREE.Mesh(merged, material); mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'Era static cell'; this.group.add(mesh);
    }
    this.batches.clear();
  }
  dynamic(geometry, material) { this.owned.add(geometry); const mesh = new THREE.Mesh(geometry, material); this.group.add(mesh); return mesh; }
  dispose() { for (const g of this.owned) g.dispose(); this.owned.clear(); }
}
