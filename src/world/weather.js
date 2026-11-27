import * as THREE from 'three';
import { seededRandom } from '../core/rng.js';

export class Weather {
  constructor(scene) {
    this.scene = scene; this.elapsed = 0; this.era = 'present'; this.flash = 0; this.lightning = 0; this.nextLightning = 13;
    const random = seededRandom('rain'), count = 900, data = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) { const x = (random() - .5) * 65, y = random() * 25, z = (random() - .5) * 65; data.set([x, y, z, x + .03, y - .6, z + .025], i * 6); }
    this.geometry = new THREE.BufferGeometry(); this.geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
    this.material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uTime: { value: 0 }, uOpacity: { value: .16 }, uDust: { value: 0 } },
      vertexShader: `uniform float uTime,uDust; void main(){vec3 p=position; p.y=mod(p.y-uTime*mix(15.,.2,uDust)+300.,25.); p.x+=sin(uTime*.25)*uDust*4.; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
      fragmentShader: `uniform float uOpacity,uDust; void main(){gl_FragColor=vec4(mix(vec3(.6,.78,.85),vec3(.75,.57,.34),uDust),uOpacity);}`,
    });
    this.rain = new THREE.LineSegments(this.geometry, this.material); this.rain.frustumCulled = false; scene.add(this.rain);
    this.light = new THREE.AmbientLight(0xaccfff, 0); scene.add(this.light);
  }
  setEra(era) { this.era = era; this.elapsed = 0; this.nextLightning = 13; this.flash = 0; this.lightning = 0; this.light.intensity = 0; this.rain.visible = era === 'present' || era === 'oldwest'; this.material.uniforms.uDust.value = era === 'oldwest' ? 1 : 0; }
  update(dt, time, position) {
    this.elapsed += dt; this.material.uniforms.uTime.value = this.elapsed;
    if (position) this.rain.position.set(position.x, 0, position.z);
    this.material.uniforms.uOpacity.value = this.era === 'present' ? .13 * Math.max(.15, 1 - this.elapsed / 180) : .025;
    this.flash *= Math.exp(-dt * 8); this.lightning = this.flash;
    if (this.era === 'present' && this.elapsed >= this.nextLightning && this.elapsed < 150) { this.flash = 1; this.nextLightning += 19 + Math.sin(time) * 4; }
    this.light.intensity = this.flash * 1.8;
  }
  dispose() { this.rain.removeFromParent(); this.light.removeFromParent(); this.geometry.dispose(); this.material.dispose(); }
}
