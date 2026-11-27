import * as THREE from 'three';
import {MAP} from './cockpitMap.js';
import {MONTHS} from './timeCircuits.js';
import {drawLED,drawGauges,GAUGES} from './instruments.js';
const clamp=THREE.MathUtils.clamp;
function canvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
export class Cockpit {
  constructor(camera){this.camera=camera;camera.layers.enable(1);this.group=new THREE.Group();camera.add(this.group);this.group.visible=false;this.zoom=0;this.panX=0;this.panY=0;this.lastDraw=-1;this.calibrate=new URLSearchParams(location.search).has('calib');}
  async load(){
    const img=new Image();img.src='/img/cockpit.png';await img.decode();this.image=img;
    const base=canvas(MAP.width,MAP.height),ctx=base.getContext('2d');ctx.drawImage(img,0,0);
    ctx.globalCompositeOperation='destination-out';ctx.beginPath();MAP.windshield.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();ctx.globalCompositeOperation='source-over';
    // Retain the supplied photograph while translating its instrument labels.
    for(const [i,label] of ['DESTINO','PRESENTE','ÚLTIMA PARTIDA'].entries()){ctx.fillStyle='#100f0d';ctx.fillRect(1315,394+i*116,202,23);ctx.fillStyle='#dbd8c4';ctx.font='bold 16px monospace';ctx.textAlign='center';ctx.fillText(label,1416,411+i*116);}
    const tex=new THREE.CanvasTexture(base);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=4;
    this.base=this.makePlane({x:0,y:0,w:MAP.width,h:MAP.height},tex,1);
    this.panelCanvas=canvas(MAP.panel.w,MAP.panel.h);this.panelTexture=new THREE.CanvasTexture(this.panelCanvas);this.panelTexture.colorSpace=THREE.SRGBColorSpace;this.makePlane(MAP.panel,this.panelTexture,2);
    this.speedCanvas=canvas(MAP.speed.w*2,MAP.speed.h*2);this.speedTexture=new THREE.CanvasTexture(this.speedCanvas);this.speedTexture.colorSpace=THREE.SRGBColorSpace;this.makePlane(MAP.speed,this.speedTexture,3);
    this.gaugeCanvas=canvas(GAUGES.w,GAUGES.h);this.gaugeTexture=new THREE.CanvasTexture(this.gaugeCanvas);this.gaugeTexture.colorSpace=THREE.SRGBColorSpace;this.gauges=this.makePlane(GAUGES,this.gaugeTexture,2);
    this.roof=this.makePlane({x:-5000,y:-8000,w:5057,h:9000},null,0);this.roof.material.color.set(0x12171b);
    this.bottom=this.makePlane({x:-5000,y:940,w:10000,h:4000},null,0);this.bottom.material.color.set(0x090b0d);
    this.right=this.makePlane({x:1671,y:0,w:5000,h:4000},null,0);this.right.material.color.set(0x090b0d);
    if(this.calibrate){ctx.strokeStyle='#00ffff';ctx.lineWidth=3;ctx.beginPath();MAP.windshield.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();Object.values(MAP).filter(v=>v?.w).forEach(r=>ctx.strokeRect(r.x,r.y,r.w,r.h));tex.needsUpdate=true;}
  }
  makePlane(r,texture,order){const distance=.12;const geometry=new THREE.PlaneGeometry(r.w/MAP.focal*distance,r.h/MAP.focal*distance);const material=new THREE.MeshBasicMaterial({map:texture,transparent:!!texture,depthTest:false,depthWrite:false,toneMapped:false});const mesh=new THREE.Mesh(geometry,material);mesh.layers.set(1);mesh.position.set((r.x+r.w/2-MAP.vx)/MAP.focal*distance,-(r.y+r.h/2-MAP.vy)/MAP.focal*distance,-distance);mesh.renderOrder=1000+order;mesh.frustumCulled=false;this.group.add(mesh);return mesh;}
  setVisible(visible){this.group.visible=visible;if(!visible){this.camera.clearViewOffset();this.camera.fov=62;this.camera.updateProjectionMatrix();}}
  update(dt,t,{panel,look,speedMph,circuits,night,charge}){
    if(!this.group.visible||!this.image)return;
    this.zoom=THREE.MathUtils.damp(this.zoom,panel?1:0,6,dt);
    this.panX=clamp(this.panX-look.x*.12,-28,28);this.panY=clamp(this.panY-look.y*.1,-16,16);
    this.panX*=Math.exp(-dt*1.8);this.panY*=Math.exp(-dt*1.8);
    const W=innerWidth,H=innerHeight,drive=1.06*Math.max(W/MAP.width,H/(2*(MAP.height-MAP.dashY)));
    const zoom=Math.min(W/660,H/480),s=THREE.MathUtils.lerp(drive,zoom,this.zoom);
    const ox=THREE.MathUtils.lerp((W-drive*MAP.width)/2,W*.5-1420*zoom,this.zoom)+this.panX;
    const oy=THREE.MathUtils.lerp(H/2-drive*MAP.dashY,H*.48-480*zoom,this.zoom)+this.panY;
    const f=s*MAP.focal,px=ox+s*MAP.vx,py=oy+s*MAP.vy;
    this.camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(H/(2*f)));this.camera.aspect=W/H;
    this.camera.setViewOffset(W,H,W/2-px,H/2-py,W,H);this.camera.updateProjectionMatrix();
    this.projection={scale:s,offsetX:ox,offsetY:oy,vanishingX:px,vanishingY:py,width:W,height:H};
    this.base.material.color.setScalar(night?.82:1);
    this.gauges.material.color.copy(this.base.material.color);
    if(t-this.lastDraw>.09){this.draw(circuits,speedMph,panel,t,charge);this.lastDraw=t;}
  }
  draw(circuits,speed,panel,t,charge){
    const ctx=this.panelCanvas.getContext('2d'),r=MAP.panel;ctx.drawImage(this.image,r.x,r.y,r.w,r.h,0,0,r.w,r.h);
    const data=[circuits.destination,circuits.now,circuits.last];
    MAP.rows.forEach((row,i)=>{
      const y=row.y-r.y;let values=data[i]?[MONTHS[data[i].month-1],String(data[i].day).padStart(2,'0'),String(data[i].year).padStart(4,'0'),String(data[i].hour).padStart(2,'0'),String(data[i].minute).padStart(2,'0')]:['---','--','----','--','--'];
      if(i===0&&panel){let offset=0;values=[2,2,4,2,2].map(n=>{const val=circuits.buffer.slice(offset,offset+n).padEnd(n,'_');offset+=n;return val;});}
      if(i===2){ctx.fillStyle='#090c09';ctx.fillRect(1505-r.x,574-r.y,132,48);ctx.fillRect(1465-r.x,559-r.y,41,63);ctx.fillStyle='#6f2921';ctx.fillRect(1505-r.x,548-r.y,132,29);ctx.fillStyle='#0c0c0b';ctx.fillRect(1303-r.x,625-r.y,234,29);}
      MAP.fields.forEach((field,j)=>{const x=field.x-r.x;ctx.fillStyle='#090c09';ctx.fillRect(x-3,y-5,field.w+6,45);ctx.fillStyle=row.color;ctx.textAlign='center';
        if(/^[\d_\-]+$/.test(values[j]))drawLED(ctx,values[j],x+5,y+1,field.w-10,29,row.color);else{ctx.shadowColor=row.color;ctx.shadowBlur=5;ctx.font='italic 27px monospace';ctx.fillText(values[j],x+field.w/2,y+29);ctx.shadowBlur=0;}
        ctx.fillStyle='#6f2921';ctx.fillRect(x-3,y-30,field.w+6,24);ctx.fillStyle='#e8c8a9';ctx.font='bold 12px monospace';ctx.fillText(['MÊS','DIA','ANO','HORA','MIN'][j],x+field.w/2,y-14);
      });
      ctx.fillStyle='#0a0d0b';ctx.fillRect(1466-r.x,y-2,29,38);ctx.fillStyle=row.color;ctx.beginPath();ctx.arc(1480-r.x,y+(data[i]?.hour>=12?26:5),4,0,Math.PI*2);ctx.fill();
      if(i===2){ctx.fillStyle=row.color;for(const dy of [9,24]){ctx.beginPath();ctx.arc(1563-r.x,y+dy,2,0,Math.PI*2);ctx.fill();}}
      ctx.fillStyle='#0c0c0b';ctx.fillRect(1315-r.x,y+46,204,23);ctx.fillStyle='#e2dac5';ctx.font='bold 14px monospace';ctx.textAlign='center';ctx.fillText(['DESTINO','PRESENTE','ÚLTIMA PARTIDA'][i],1418-r.x,y+62);
    });this.panelTexture.needsUpdate=true;
    const sc=this.speedCanvas.getContext('2d');sc.fillStyle='#100b0a';sc.fillRect(0,0,this.speedCanvas.width,this.speedCanvas.height);const value=String(Math.round(Math.abs(speed))).padStart(2,'0');drawLED(sc,value,52,12,this.speedCanvas.width-84,96,charge>0&&Math.sin(t*9)>.7?'#ffc18a':'#ff4938');this.speedTexture.needsUpdate=true;
    drawGauges(this.gaugeCanvas.getContext('2d'),this.image,speed,t);this.gaugeTexture.needsUpdate=true;
  }
  dispose(){this.group.traverse(o=>{o.geometry?.dispose();o.material?.map?.dispose();o.material?.dispose();});this.group.removeFromParent();}
}
