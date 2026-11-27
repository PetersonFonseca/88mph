import * as THREE from 'three';

export class Sky {
  constructor(scene, renderer = null) {
    this.scene = scene; this.renderer = renderer; this.isNight = true; this.daylight = 0;
    this.hemisphere = new THREE.HemisphereLight(0x90b7d8, 0x1b2535, .8); scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(0xd8eaff, 1.1); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024); this.sun.shadow.camera.left = -55; this.sun.shadow.camera.right = 55; this.sun.shadow.camera.top = 55; this.sun.shadow.camera.bottom = -55; this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 220; this.sun.shadow.bias = -.0005; this.sun.shadow.normalBias = .035;
    scene.add(this.sun, this.sun.target);
    this.fill = new THREE.AmbientLight(0x6c8cb9, .22); scene.add(this.fill);
    this.flashLight = new THREE.AmbientLight(0xc0d9ff, 0); scene.add(this.flashLight);
    scene.fog = scene.fog || new THREE.FogExp2(0x091721, .004);
    this.uniforms = { uTop: { value: new THREE.Color(0x07101e) }, uHorizon: { value: new THREE.Color(0x1d3546) }, uDay: { value: 0 }, uTime: { value: 0 }, uSun: { value: new THREE.Vector3(.3, .5, -.7).normalize() }, uDusk: { value: 0 } };
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.uniforms,
      vertexShader: `varying vec3 vDirection; void main(){vDirection=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        varying vec3 vDirection; uniform vec3 uTop,uHorizon,uSun; uniform float uDay,uTime,uDusk;
        float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
        void main(){
          vec3 d=normalize(vDirection); float h=max(0.,d.y);
          vec3 color=mix(uHorizon,uTop,pow(h,.45));
          float sun=pow(max(0.,dot(d,uSun)),800.);
          color+=sun*mix(vec3(.65,.85,1.1),vec3(3.,2.3,1.4),uDay);
          color+=pow(max(0.,dot(d,uSun)),10.)*.22*uDusk*vec3(1.,.33,.12);
          vec3 cell=floor(d*620.); float stars=step(.998,hash(cell))*pow(hash(cell+19.),12.)*(1.-uDay)*smoothstep(0.,.2,h);
          color+=stars*1.6;
          float cloud=sin(d.x*9.+uTime*.007+sin(d.z*14.))*sin(d.z*18.-uTime*.003+sin(d.x*7.));
          color+=smoothstep(.18,.8,cloud)*.045*(.25+uDay)*smoothstep(0.,.12,h)*(1.-smoothstep(.35,.8,h));
          gl_FragColor=vec4(color,1.);
        }`,
    });
    this.geometry = new THREE.SphereGeometry(1100, 24, 12); this.dome = new THREE.Mesh(this.geometry, this.material); this.dome.frustumCulled = false; this.dome.renderOrder = -100; scene.add(this.dome);
    this.canvas = document.createElement('canvas'); this.canvas.width = 256; this.canvas.height = 128;
    this.environment = new THREE.CanvasTexture(this.canvas); this.environment.colorSpace = THREE.SRGBColorSpace; this.environment.mapping = THREE.EquirectangularReflectionMapping;
    // Three caches PMREM for ordinary image textures; needsUpdate alone would leave
    // the first night's lighting baked into every later arrival. Reuse an explicit target.
    this.pmrem = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.environmentTarget = null;
    scene.environment = this.environment; scene.environmentIntensity = .8;
    this.setDate({ hour: 22, minute: 4 }, 'present');
  }
  setDate(date, era = 'present') {
    this.hour = date.hour + (date.minute || 0) / 60; this.era = era;
    const elevation = Math.sin((this.hour - 6) / 24 * Math.PI * 2);
    this.daylight = THREE.MathUtils.smoothstep(elevation, -.13, .35); this.isNight = this.daylight < .2;
    const dusk = (1 - Math.abs(elevation)) ** 12;
    const top = new THREE.Color(era === 'oldwest' ? 0x4d91bf : 0x498fc6);
    top.lerp(new THREE.Color(era === 'future' ? 0x060d20 : 0x081320), 1 - this.daylight);
    const horizon = new THREE.Color(era === 'oldwest' ? 0xd5b27e : 0xacc7ca);
    horizon.lerp(new THREE.Color(era === 'future' ? 0x15223d : 0x273a49), 1 - this.daylight);
    horizon.lerp(new THREE.Color(0xc78969), dusk * .45);
    this.uniforms.uTop.value.copy(top); this.uniforms.uHorizon.value.copy(horizon); this.uniforms.uDay.value = this.daylight; this.uniforms.uDusk.value = dusk;
    this.sunDirection = new THREE.Vector3(.35, this.isNight ? .58 : Math.max(.07, elevation), -.7).normalize(); this.uniforms.uSun.value.copy(this.sunDirection);
    this.sun.color.set(this.isNight ? 0xb9d5ee : dusk > .2 ? 0xffcf9e : 0xfff1d8); this.sun.intensity = .45 + this.daylight * 2.2;
    this.hemisphere.color.set(this.isNight ? 0x7399bb : 0xc5e7ff); this.hemisphere.groundColor.set(era === 'oldwest' ? 0x816549 : 0x33423d); this.hemisphere.intensity = .7 + this.daylight * 1.1;
    this.fill.intensity = .2 + this.daylight * .12;
    this.scene.fog.color.copy(horizon).multiplyScalar(this.isNight ? .58 : .9); this.scene.fog.density = era === 'oldwest' ? .0026 : era === 'future' ? .0032 : this.isNight ? .0042 : .0028;
    const c = this.canvas.getContext('2d'), gradient = c.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, `#${top.getHexString()}`); gradient.addColorStop(.5, `#${horizon.getHexString()}`); gradient.addColorStop(.58, era === 'oldwest' ? '#99815c' : '#344748'); gradient.addColorStop(1, '#132025');
    c.fillStyle = gradient; c.fillRect(0, 0, 256, 128);
    c.fillStyle = this.isNight ? '#b1c9d0' : '#fff4cf'; c.fillRect(68, 30, 8, 8);
    if (this.isNight) for (let i = 0; i < 12; i++) { c.fillStyle = i % 2 ? '#a4c9cb' : '#c9aa7f'; c.fillRect(i * 23, 61, 3, 6); }
    this.environment.needsUpdate = true;
    if (this.pmrem) {
      this.environmentTarget = this.pmrem.fromEquirectangular(this.environment, this.environmentTarget);
      this.scene.environment = this.environmentTarget.texture;
    }
    this.scene.environmentIntensity = this.isNight ? .9 : 1.15;
  }
  update(dt, t, position) {
    this.uniforms.uTime.value = t;
    if (position) {
      this.dome.position.copy(position);
      this.sun.target.position.set(position.x, 0, position.z);
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDirection, 95);
      this.sun.target.updateMatrixWorld();
    }
    this.flashLight.intensity *= Math.exp(-dt * 10);
  }
  flash(amount = 2) { this.flashLight.intensity = amount; }
  dispose() {
    if (this.scene.environment === this.environment || this.scene.environment === this.environmentTarget?.texture) this.scene.environment = null;
    this.geometry.dispose(); this.material.dispose(); this.environment.dispose();
    this.environmentTarget?.dispose(); this.pmrem?.dispose();
    this.sun.shadow.dispose(); for (const object of [this.dome, this.sun, this.sun.target, this.hemisphere, this.fill, this.flashLight]) object.removeFromParent();
  }
}
