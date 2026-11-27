import * as THREE from 'three';

/** A fixed-size GPU point pool. Emissions reuse slots, so travel never allocates meshes. */
export class ParticleSystem {
  constructor(scene, capacity = 900) {
    this.capacity = capacity;
    this.cursor = 0;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.geometry = new THREE.BufferGeometry();
    for (const [name, array, size] of [
      ['position', this.positions, 3], ['color', this.colors, 3],
      ['size', this.sizes, 1], ['alpha', this.alphas, 1],
    ]) {
      this.geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: { pixelScale: { value: Math.min(globalThis.devicePixelRatio || 1, 1.5) * 420 } },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float pixelScale;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(size * pixelScale / max(-mv.z, 0.5), 1.0, 100.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float radius = length(gl_PointCoord - 0.5) * 2.0;
          float glow = max(0.0, 1.0 - radius);
          if (glow < 0.005 || vAlpha < 0.001) discard;
          gl_FragColor = vec4(vColor, glow * glow * vAlpha);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'Partículas da viagem';
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit({ position, velocity = [0, 1, 0], color = [1, 1, 1], size = 0.3, life = 1, gravity = 0 }) {
    const i = this.cursor++ % this.capacity;
    const p = i * 3;
    this.positions[p] = position.x ?? position[0];
    this.positions[p + 1] = position.y ?? position[1];
    this.positions[p + 2] = position.z ?? position[2];
    this.velocities.set(velocity, p);
    this.colors.set(color, p);
    this.sizes[i] = size;
    this.alphas[i] = 1;
    this.lifetimes[i] = Math.max(life, 0.01);
    this.ages[i] = 0;
    this.gravity[i] = gravity;
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    for (let i = 0; i < this.capacity; i++) {
      if (!this.lifetimes[i]) continue;
      this.ages[i] += dt;
      if (this.ages[i] >= this.lifetimes[i]) {
        this.alphas[i] = 0;
        this.lifetimes[i] = 0;
        continue;
      }
      const p = i * 3;
      this.velocities[p + 1] += this.gravity[i] * dt;
      this.positions[p] += this.velocities[p] * dt;
      this.positions[p + 1] += this.velocities[p + 1] * dt;
      this.positions[p + 2] += this.velocities[p + 2] * dt;
      const remaining = 1 - this.ages[i] / this.lifetimes[i];
      this.alphas[i] = Math.min(this.ages[i] * 12 + 0.15, 1) * remaining * remaining;
    }
    for (const attribute of Object.values(this.geometry.attributes)) attribute.needsUpdate = true;
  }

  clear() {
    this.lifetimes.fill(0);
    this.alphas.fill(0);
    this.geometry.attributes.alpha.needsUpdate = true;
  }

  dispose() {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
