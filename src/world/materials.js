import * as THREE from 'three';
import { seededRandom } from '../core/rng.js';

export function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export class MaterialLibrary {
  constructor() {
    this.materials = new Map(); this.textures = new Set();
    const random = seededRandom('asphalt');
    this.roadTexture = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#373e43'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 14000; i++) { const g = Math.floor(26 + random() * 58); ctx.fillStyle = `rgba(${g},${g + 3},${g + 5},.5)`; ctx.fillRect(random() * w, random() * h, 1, 1); }
    });
    this.roadTexture.wrapS = this.roadTexture.wrapT = THREE.RepeatWrapping; this.roadTexture.repeat.set(3, 160);
    this.textures.add(this.roadTexture);
  }
  get(name, options = {}) {
    if (!this.materials.has(name)) this.materials.set(name, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, ...options }));
    return this.materials.get(name);
  }
  unlit(name, color, brightness = 1) {
    if (!this.materials.has(name)) this.materials.set(name, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(brightness) }));
    return this.materials.get(name);
  }
  sign(text, color = '#b8faff', background = '#17272e', fontSize = 70) {
    const key = `sign:${text}:${color}:${background}`;
    if (!this.materials.has(key)) {
      const texture = canvasTexture(1024, 256, (ctx, w, h) => {
        ctx.fillStyle = background; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.strokeRect(12, 12, w - 24, h - 24);
        ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `700 ${fontSize}px sans-serif`; ctx.fillText(text, w / 2, h / 2, w - 70);
      });
      this.textures.add(texture);
      this.materials.set(key, new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.5, side: THREE.DoubleSide }));
    }
    return this.materials.get(key);
  }
  dispose() { for (const m of this.materials.values()) m.dispose(); for (const t of this.textures) t.dispose(); }
}
