import * as THREE from 'three';
import {CarPhysics} from './carPhysics.js';
import {createCarModel} from './carModel.js';
import {isFree} from '../core/collision.js';
export class CarController {
  constructor(scene){this.physics=new CarPhysics();this.model=createCarModel();scene.add(this.model.group);this.view='cockpit';this.doorOpen=false;this.occupied=false;this.cameraReady=false;this.colliders=[-1.38,0,1.38].map(offset=>({type:'circle',x:0,z:0,radius:.86,offset}));this.sync();}
  driverPoint(side=-1){return new THREE.Vector3(side*1.7,0,.1).applyAxisAngle(new THREE.Vector3(0,1,0),this.physics.yaw).add(this.physics.position);}
  canEnter(walker){const p=this.driverPoint();return Math.hypot(p.x-walker.position.x,p.z-walker.position.z)<2.5;}
  enter(){this.occupied=true;this.doorOpen=false;this.cameraReady=false;}
  exit(walker,colliders){if(Math.abs(this.physics.speedMph)>2)return false;let p=this.driverPoint();if(!isFree(p.x,p.z,.35,colliders))p=this.driverPoint(1);if(!isFree(p.x,p.z,.35,colliders))return false;this.physics.speed=0;this.physics.steer=0;this.physics.braking=false;walker.position.copy(p);walker.position.y=1.7;walker.yaw=this.physics.yaw;walker.pitch=0;this.occupied=false;this.doorOpen=true;this.cameraReady=false;return true;}
  update(dt,input,world,drive=true){if(drive){this.physics.step(dt,{throttle:Number(input.down('KeyW'))-Number(input.down('KeyS')),steer:Number(input.down('KeyA'))-Number(input.down('KeyD')),handbrake:input.down('Space')},world.surfaceAt,world.colliders);}this.sync();const charge=THREE.MathUtils.clamp((Math.abs(this.physics.speedMph)-75)/13,0,1);this.model.update(dt,{speed:this.physics.speed,steer:this.physics.steer,doorOpen:this.doorOpen,charge,brake:this.physics.braking});}
  sync(){this.model.group.position.copy(this.physics.position);this.model.group.rotation.y=this.physics.yaw;const p=this.physics.position;for(const collider of this.colliders){collider.x=p.x-Math.sin(this.physics.yaw)*collider.offset;collider.z=p.z-Math.cos(this.physics.yaw)*collider.offset;}}
  applyCamera(camera,dt){const yaw=this.physics.yaw,p=this.physics.position;
    if(this.view==='cockpit'){const eye=new THREE.Vector3(-.38,1.19,-.18).applyAxisAngle(new THREE.Vector3(0,1,0),yaw).add(p);camera.position.copy(eye);camera.rotation.set(0,yaw,0,'YXZ');this.model.group.visible=false;}
    else{this.model.group.visible=true;const behind=new THREE.Vector3(0,3.7,8).applyAxisAngle(new THREE.Vector3(0,1,0),yaw).add(p);if(!this.cameraReady)camera.position.copy(behind);else camera.position.lerp(behind,1-Math.exp(-dt*6));camera.lookAt(p.x-Math.sin(yaw)*5,p.y+.8,p.z-Math.cos(yaw)*5);this.cameraReady=true;}
  }
}
