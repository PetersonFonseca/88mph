import * as THREE from 'three';

export class LightPool {
  constructor(scene) {
    this.lights = Array.from({ length: 8 }, () => { const light = new THREE.PointLight(0xffd59b, 0, 25, 2); scene.add(light); return light; });
    this.sorted = [];
  }
  update(lamps = [], position = new THREE.Vector3(), isNight = true) {
    // A permanent eight-light set avoids generating new shader variants per era or hour.
    this.sorted.length = 0;
    for (const lamp of lamps) this.sorted.push({ lamp, distance: (lamp.x - position.x) ** 2 + (lamp.z - position.z) ** 2 });
    this.sorted.sort((a, b) => a.distance - b.distance);
    this.lights.forEach((light, i) => {
      const entry = this.sorted[i];
      if (!entry) { light.intensity = 0; return; }
      const lamp = entry.lamp; light.position.copy(lamp.position); light.color.set(lamp.color); light.intensity = isNight ? lamp.intensity : 0;
    });
  }
  dispose() { this.lights.forEach(light => light.removeFromParent()); this.lights.length = 0; }
}
