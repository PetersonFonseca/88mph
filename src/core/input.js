export class Input {
  keys=new Set(); lookX=0; lookY=0; locked=false; dragging=false;
  constructor(canvas,state,onAction,onPause){
    this.canvas=canvas;this.state=state;this.onAction=onAction;this.onPause=onPause;
    window.addEventListener('keydown',e=>{
      if(e.target.matches('input,button,select,textarea'))return;
      if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
      if(state.mode==='panel'){if(!e.repeat)onAction(e);return;}
      const previousMode=state.mode;if(!e.repeat)onAction(e);if(!state.paused&&state.mode===previousMode)this.keys.add(e.code);
    });
    window.addEventListener('keyup',e=>this.keys.delete(e.code));
    window.addEventListener('blur',()=>{this.clear();if(state.mode!=='title')onPause();});
    document.addEventListener('pointerlockchange',()=>{
      const was=this.locked;this.locked=document.pointerLockElement===canvas;
      if(was&&!this.locked&&!['title','panel'].includes(state.mode))onPause();
    });
    document.addEventListener('mousemove',e=>{if(!state.paused&&(this.locked||this.dragging)){this.lookX+=e.movementX;this.lookY+=e.movementY;}});
    canvas.addEventListener('pointerdown',()=>{this.dragging=true;if(!state.paused)this.lock();});
    window.addEventListener('pointerup',()=>this.dragging=false);
    state.onChange(()=>this.clear());
  }
  down(code){return this.keys.has(code);}
  clear(){this.keys.clear();this.lookX=this.lookY=0;this.dragging=false;}
  consumeLook(){const v={x:this.lookX,y:this.lookY};this.lookX=this.lookY=0;return v;}
  async lock(){try{await this.canvas.requestPointerLock?.();}catch{/* Drag-to-look remains available in embedded browsers. */}}
}
