import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A half-resolution planar reflection supplies the world; soft lamp streaks add the wet asphalt response.
export function createWetRoad(lamps) {
  const group = new THREE.Group(); group.name = 'Reflexos e poças';
  const road = new THREE.PlaneGeometry(14, 1200), yard = new THREE.PlaneGeometry(23, 43);
  yard.translate(18.5, -14.5, 0);
  const mirrorGeometry = mergeGeometries([road, yard]); road.dispose(); yard.dispose();
  const shader = {
    uniforms: THREE.UniformsUtils.clone(Reflector.ReflectorShader.uniforms),
    vertexShader: Reflector.ReflectorShader.vertexShader.replace('varying vec4 vUv;', 'varying vec4 vUv; varying vec3 vWorld;').replace('vUv = textureMatrix', 'vWorld = (modelMatrix * vec4(position, 1.)).xyz; vUv = textureMatrix'),
    fragmentShader: Reflector.ReflectorShader.fragmentShader.replace('varying vec4 vUv;', 'varying vec4 vUv; varying vec3 vWorld; uniform float uTime;').replace('vec4 base = texture2DProj( tDiffuse, vUv );', `
      vec4 uv = vUv;
      uv.x += sin(vWorld.z * 8. + uTime * 1.7) * .00012 * uv.w;
      uv.y += sin(vWorld.x * 12. + vWorld.z * 4. + uTime) * .00015 * uv.w;
      vec4 base = texture2DProj(tDiffuse, uv);
      float puddle = smoothstep(.15, .72, sin(vWorld.x * 1.6 + sin(vWorld.z * .26)) * cos(vWorld.z * .7));
    `).replace('vec4( blendOverlay( base.rgb, color ), 1.0 )', 'vec4( blendOverlay(base.rgb, color), .13 + puddle * .38 )'),
  };
  shader.uniforms.uTime = { value: 0 };
  const reflector = new Reflector(mirrorGeometry, {
    textureWidth: Math.min(960, Math.max(320, Math.floor((globalThis.innerWidth || 1280) / 2))),
    textureHeight: Math.min(540, Math.max(180, Math.floor((globalThis.innerHeight || 720) / 2))),
    clipBias: .003, color: 0x808b92, multisample: 0, shader,
  });
  reflector.rotation.x = -Math.PI / 2; reflector.position.y = .025;
  reflector.material.transparent = true; reflector.material.depthWrite = false;
  const renderReflection = reflector.onBeforeRender;
  reflector.onBeforeRender = function (renderer, scene, camera) {
    this.getReflectionCamera(camera).layers.set(0);
    renderReflection.call(this, renderer, scene, camera);
  };
  reflector.visible = new URLSearchParams(globalThis.location?.search || '').get('reflections') !== '0';
  group.add(reflector);
  const textureCanvas = document.createElement('canvas'); textureCanvas.width = 64; textureCanvas.height = 256;
  const c = textureCanvas.getContext('2d');
  for (let y = 0; y < 256; y++) {
    const alpha = Math.pow(1 - Math.abs(y - 128) / 128, 2) * (.4 + .6 * Math.sin(y * 5.3) ** 2);
    const g = c.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, 'rgba(255,220,150,0)'); g.addColorStop(.5, `rgba(255,220,150,${alpha})`); g.addColorStop(1, 'rgba(255,220,150,0)');
    c.fillStyle = g; c.fillRect(0, y, 64, 1);
  }
  const texture = new THREE.CanvasTexture(textureCanvas); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: .23, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2 });
  const geometry = new THREE.PlaneGeometry(1.5, 17); geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geometry, material, lamps.length); const matrix = new THREE.Matrix4();
  lamps.forEach((lamp, i) => { matrix.makeTranslation(Math.sign(lamp.x) * 4.8, .033, lamp.z + 2); mesh.setMatrixAt(i, matrix); });
  mesh.instanceMatrix.needsUpdate = true; group.add(mesh);
  return { group, reflector, update(t) { material.opacity = .22 + Math.sin(t * 1.1) * .018; reflector.material.uniforms.uTime.value = t; }, dispose() { mesh.dispose(); geometry.dispose(); material.dispose(); texture.dispose(); mirrorGeometry.dispose(); reflector.dispose(); } };
}
