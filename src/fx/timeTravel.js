import * as THREE from 'three';
import { ParticleSystem } from './particles.js';

const ARC_COUNT = 8;
const SEGMENTS = 11;

export class TimeTravelFX {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Efeitos de viagem temporal';
    scene.add(this.group);
    this.particles = new ParticleSystem(scene, 1200);
    this.arcPositions = new Float32Array(ARC_COUNT * SEGMENTS * 6);
    this.arcGeometry = new THREE.BufferGeometry();
    this.arcGeometry.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.arcMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(0.15, 2.5, 5), transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.arcs = new THREE.LineSegments(this.arcGeometry, this.arcMaterial);
    this.arcs.frustumCulled = false;
    this.group.add(this.arcs);

    this.trailMaterial = new THREE.ShaderMaterial({
      uniforms: { age: { value: 10 }, time: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float age;
        uniform float time;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          float edge = pow(max(0.0, 1.0 - abs(vUv.x - 0.5) * 2.0), 0.7);
          float flicker = 0.65 + 0.35 * hash(floor(vUv * vec2(9.0, 170.0) + vec2(time * 10.0)));
          float ends = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
          float fade = max(0.0, 1.0 - age / 5.5);
          gl_FragColor = vec4(mix(vec3(4.0, 0.23, 0.01), vec3(5.0, 2.3, 0.2), edge * flicker), edge * ends * fade * flicker);
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.trailGeometry = new THREE.PlaneGeometry(0.38, 28, 1, 1);
    this.trails = new THREE.Group();
    this.trails.name = 'Dois rastros de fogo';
    for (const x of [-0.79, 0.79]) {
      const trail = new THREE.Mesh(this.trailGeometry, this.trailMaterial);
      trail.rotation.x = -Math.PI / 2;
      trail.position.set(x, 0.045, 14);
      this.trails.add(trail);
    }
    this.trails.visible = false;
    this.group.add(this.trails);

    this.ringGeometry = new THREE.RingGeometry(0.92, 1, 64);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.4, 2, 4), transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);
    this.trailAge = 10;
    this.ringAge = 10;
    this.arrivalAge = 10;
    this.arcClock = 0;
    this.emissionClock = 0;
    this.departurePosition = new THREE.Vector3();
    this.arrivalPosition = new THREE.Vector3();
    this.departureYaw = 0;
    this.flash = 0;
  }

  beginDeparture(position, yaw = 0) {
    this.departurePosition.copy(position);
    this.departureYaw = yaw;
    this.trails.position.copy(position);
    this.trails.rotation.y = yaw;
    this.trails.visible = true;
    this.trailAge = 0;
    this.emissionClock = 0;
    this.startRing(position);
    for (let i = 0; i < 160; i++) this.emitFire(Math.random() * 28);
    for (let i = 0; i < 60; i++) {
      const angle = Math.random() * Math.PI * 2;
      this.particles.emit({
        position: [position.x, position.y + 0.9, position.z],
        velocity: [Math.cos(angle) * 7, 1 + Math.random() * 4, Math.sin(angle) * 7],
        color: [0.3, 2.5, 5], size: 0.12 + Math.random() * 0.2, life: 0.6 + Math.random() * 0.9,
        gravity: -2,
      });
    }
  }

  beginArrival(position, yaw = 0) {
    this.arrivalPosition.copy(position);
    this.arrivalYaw = yaw;
    this.arrivalAge = 0;
    this.startRing(position);
    for (let i = 0; i < 100; i++) this.emitVapor(position, yaw);
  }

  startRing(position) {
    this.ringAge = 0;
    this.ring.position.set(position.x, 0.08, position.z);
  }

  emitFire(distance) {
    const localX = (Math.random() < 0.5 ? -0.79 : 0.79) + (Math.random() - 0.5) * 0.23;
    const c = Math.cos(this.departureYaw), s = Math.sin(this.departureYaw);
    this.particles.emit({
      position: [this.departurePosition.x + c * localX + s * distance, 0.1, this.departurePosition.z - s * localX + c * distance],
      velocity: [(Math.random() - 0.5) * 0.4, 0.55 + Math.random() * 1.4, (Math.random() - 0.5) * 0.4],
      color: [3.8, 0.45 + Math.random() * 1.25, 0.04],
      size: 0.25 + Math.random() * 0.45, life: 0.7 + Math.random() * 1.1,
    });
  }

  emitVapor(position, yaw) {
    const x = (Math.random() - 0.5) * 2.1, z = (Math.random() - 0.5) * 4.2;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.particles.emit({
      position: [position.x + c * x + s * z, 0.2 + Math.random() * 0.5, position.z - s * x + c * z],
      velocity: [x * 0.5, 0.3 + Math.random() * 0.6, z * 0.2],
      color: [0.45, 0.75, 1.1], size: 0.6 + Math.random() * 1.1,
      life: 1.2 + Math.random() * 1.6,
    });
  }

  update(dt, t, { position, yaw = 0, speedMph = 0, charge = Math.max(0, (Math.abs(speedMph) - 75) / 13) } = {}) {
    dt = Math.min(dt, 0.1);
    const strength = Math.min(1, Math.max(0, charge));
    this.arcClock += dt;
    if (position) {
      this.arcs.position.copy(position);
      this.arcs.rotation.y = yaw;
    }
    this.arcMaterial.opacity = strength * (0.65 + 0.3 * Math.sin(t * 43) ** 2);
    if (strength > 0 && this.arcClock > 0.055) {
      this.arcClock = 0;
      this.regenerateArcs(t);
    }
    this.trailAge += dt;
    this.trailMaterial.uniforms.age.value = this.trailAge;
    this.trailMaterial.uniforms.time.value = t;
    this.trails.visible = this.trailAge < 5.5;
    if (this.trailAge < 3.8) {
      this.emissionClock += dt * 110 * (1 - this.trailAge / 4.5);
      while (this.emissionClock >= 1) {
        this.emissionClock--;
        this.emitFire(Math.random() * 28);
      }
    }
    this.arrivalAge += dt;
    if (this.arrivalAge < 1.2 && position) {
      for (let i = 0; i < Math.ceil(dt * 30); i++) this.emitVapor(position, yaw);
    }
    this.ringAge += dt;
    const ringScale = 0.5 + this.ringAge * 19;
    this.ring.scale.setScalar(ringScale);
    this.ringMaterial.opacity = Math.max(0, 1 - this.ringAge / 0.8) * 0.6;
    this.particles.update(dt);
  }

  regenerateArcs(time) {
    let offset = 0;
    for (let a = 0; a < ARC_COUNT; a++) {
      const side = a % 2 ? 1 : -1;
      const zStart = -2 + (a % 4) * 1.05;
      const xStart = side * (a < 4 ? 1.0 : 0.55);
      const yStart = a < 4 ? 0.55 : 1.4;
      let x = xStart, y = yStart, z = zStart;
      for (let j = 0; j < SEGMENTS; j++) {
        const f = (j + 1) / SEGMENTS;
        const bulge = Math.sin(f * Math.PI);
        const nextX = xStart + side * bulge * (0.25 + Math.random() * 0.32);
        const nextY = yStart + bulge * (0.2 + Math.random() * 0.4) + f * (a < 4 ? 0.65 : -0.7);
        const nextZ = zStart + f * 1.3 + (Math.random() - 0.5) * bulge * 0.35;
        this.arcPositions.set([x, y, z, nextX, nextY, nextZ], offset);
        offset += 6;
        x = nextX; y = nextY; z = nextZ;
      }
    }
    this.arcGeometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.particles.dispose();
    for (const resource of [this.arcGeometry, this.arcMaterial, this.trailGeometry, this.trailMaterial, this.ringGeometry, this.ringMaterial]) resource.dispose();
  }
}
