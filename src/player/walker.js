import * as THREE from 'three';
import {moveCircle} from '../core/collision.js';
export class Walker {
  position=new THREE.Vector3(7,1.7,25);yaw=-.62;pitch=-.04;walking=false;bob=0;
  update(dt,input,colliders){const look=input.consumeLook();this.yaw-=look.x*.002;this.pitch=THREE.MathUtils.clamp(this.pitch-look.y*.002,-1.25,1.25);
    const forward=Number(input.down('KeyW'))-Number(input.down('KeyS')),side=Number(input.down('KeyD'))-Number(input.down('KeyA'));
    this.walking=!!(forward||side);const scale=(input.down('ShiftLeft')?6.3:3.4)*dt/Math.max(1,Math.hypot(forward,side));
    const dx=(-Math.sin(this.yaw)*forward+Math.cos(this.yaw)*side)*scale,dz=(-Math.cos(this.yaw)*forward-Math.sin(this.yaw)*side)*scale;
    const p=moveCircle(this.position,dx,dz,.32,colliders);this.position.x=THREE.MathUtils.clamp(p.x,-135,135);this.position.z=THREE.MathUtils.clamp(p.z,-590,590);
    if(this.walking)this.bob+=dt*(input.down('ShiftLeft')?13:9);
  }
  applyCamera(camera){camera.position.copy(this.position);camera.position.y+=this.walking?Math.sin(this.bob)*.035:0;camera.rotation.set(this.pitch,this.yaw,0,'YXZ');}
}
