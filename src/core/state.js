export const MODES = Object.freeze({TITLE:'title', WALK:'walk', CAR:'car', PANEL:'panel', DEPARTURE:'departure', ARRIVAL:'arrival'});
const edges={title:['walk','car'],walk:['car'],car:['walk','panel','departure'],panel:['car'],departure:['arrival'],arrival:['car']};
export class GameState {
  mode='title'; paused=false; listeners=new Set();
  set(mode, force=false){ if(this.mode===mode)return; if(!force&&!edges[this.mode]?.includes(mode))throw new Error(`Transição inválida: ${this.mode} → ${mode}`); this.mode=mode; this.emit(); }
  pause(value=true){this.paused=value;this.emit();}
  onChange(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emit(){for(const fn of this.listeners)fn(this);}
}
