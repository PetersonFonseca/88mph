import {parseDate} from '../car/timeCircuits.js';
export function installDebug(game){
  const debug={
    start(){game.start({lock:false});game.state.pause(false);},
    enterCar(){if(game.state.mode==='title')this.start();game.enterCar();game.state.pause(false);},
    async setDestination(value){const date=typeof value==='string'?parseDate(value):value;game.circuits.destination=date;await game.prepareDestination(date);return date;},
    setSpeedMph(value){game.car.physics.setSpeedMph(value);},
    setPosition(x=0,z=200,yaw=0){game.car.physics.reset({x,z,yaw,speed:0});game.car.sync();game.car.cameraReady=false;},
    look(yaw,pitch=0){game.walker.yaw=yaw;game.walker.pitch=pitch;},
    async travel(value){this.enterCar();await this.setDestination(value);this.setPosition(0,200,0);this.setSpeedMph(88);game.beginTravel();},
    async changeEra(era,date){const built=await game.world.prepare(era,date);game.activateEra(built);game.circuits.now={...date};},
    snapshot(){const g=game;return {mode:g.state.mode,paused:g.state.paused,era:g.world.current.era,date:{...g.circuits.now},last:{...g.circuits.last},destination:g.circuits.destination,prepared:!!g.prepared,preparing:g.preparing,speedMph:g.car.physics.speedMph,car:{x:g.car.physics.position.x,z:g.car.physics.position.z,yaw:g.car.physics.yaw,view:g.car.view,doorOpen:g.car.doorOpen},walker:{x:g.walker.position.x,z:g.walker.position.z},memory:{...g.engine.renderer.info.memory},programs:g.engine.renderer.info.programs.length,drawCalls:g.engine.renderer.info.render.calls,metrics:{...g.metrics},projection:g.cockpit.projection};},
    async frames(count=5){for(let i=0;i<count;i++)await new Promise(requestAnimationFrame);return this.snapshot();}
  };
  window.__game={...game,debug};
}
