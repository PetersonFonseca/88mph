import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
export function createEngine(container){
  const renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  renderer.outputColorSpace=THREE.SRGBColorSpace;container.prepend(renderer.domElement);
  renderer.domElement.id='world';renderer.domElement.setAttribute('aria-label','Mundo 3D de 88 MPH');
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x101c2b,0.0028);
  const camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.055,1700);scene.add(camera);
  const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
  const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.15,.2,1.5);composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grain=new ShaderPass({uniforms:{tDiffuse:{value:null},time:{value:0}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'uniform sampler2D tDiffuse;uniform float time;varying vec2 vUv;void main(){vec4 c=texture2D(tDiffuse,vUv);float n=fract(sin(dot(vUv+fract(time),vec2(12.9898,78.233)))*43758.5453);c.rgb+=(n-.5)*.016;gl_FragColor=c;}'});composer.addPass(grain);
  return {renderer,scene,camera,composer,bloom,resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h);composer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();},render(t){grain.uniforms.time.value=t;composer.render();},async warm(){await renderer.compileAsync(scene,camera);}};
}
