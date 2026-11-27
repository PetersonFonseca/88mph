const DIGITS={0:'abcdef',1:'bc',2:'abged',3:'abgcd',4:'fgbc',5:'afgcd',6:'afgecd',7:'abc',8:'abcdefg',9:'abfgcd','-':'g','_':'d'};
// Seven-segment LEDs are vector strokes painted into the cockpit's small textures.
export function drawLED(ctx,text,x,y,width,height,color){
  const chars=String(text),gap=height*.11,cw=(width-gap*(chars.length-1))/chars.length,thickness=height*.075;
  ctx.save();ctx.shadowColor=color;ctx.shadowBlur=height*.13;ctx.fillStyle=color;
  [...chars].forEach((char,i)=>{
    const left=x+i*(cw+gap),top=y,inset=thickness*.6;
    const horizontal=(yy)=>{ctx.beginPath();ctx.moveTo(left+inset+thickness,yy);ctx.lineTo(left+cw-inset-thickness,yy);ctx.lineTo(left+cw-inset,yy+thickness/2);ctx.lineTo(left+cw-inset-thickness,yy+thickness);ctx.lineTo(left+inset+thickness,yy+thickness);ctx.lineTo(left+inset,yy+thickness/2);ctx.closePath();ctx.fill();};
    const vertical=(xx,yy)=>{const hh=(height-thickness)/2;ctx.beginPath();ctx.moveTo(xx+thickness/2,yy);ctx.lineTo(xx+thickness,yy+thickness);ctx.lineTo(xx+thickness,yy+hh-thickness);ctx.lineTo(xx+thickness/2,yy+hh);ctx.lineTo(xx,yy+hh-thickness);ctx.lineTo(xx,yy+thickness);ctx.closePath();ctx.fill();};
    for(const segment of DIGITS[char]||''){
      if(segment==='a')horizontal(top);if(segment==='g')horizontal(top+(height-thickness)/2);if(segment==='d')horizontal(top+height-thickness);
      if(segment==='f')vertical(left,top+thickness*.5);if(segment==='b')vertical(left+cw-thickness,top+thickness*.5);
      if(segment==='e')vertical(left,top+height/2);if(segment==='c')vertical(left+cw-thickness,top+height/2);
    }
  });ctx.restore();
}
export const GAUGES={x:410,y:329,w:415,h:195};
export function drawGauges(ctx,image,speed,time){
  const r=GAUGES;ctx.drawImage(image,r.x,r.y,r.w,r.h,0,0,r.w,r.h);
  ctx.save();ctx.translate(-r.x,-r.y);ctx.lineCap='round';
  // Paint out the photograph's two original needles, retaining the printed scales.
  ctx.strokeStyle='#26241f';ctx.lineWidth=8;
  for(const [x,y,tx,ty] of [[520,446,594,431],[734,445,670,398]]){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(tx,ty);ctx.stroke();}
  const mph=Math.abs(speed),rpm=mph<.2?850:1500+(mph%24)*165;
  for(const [x,y,length,ratio] of [[520,446,75,Math.min(mph*1.60934/180,1)],[734,445,79,rpm/8000]]){
    const angle=2.5+ratio*4.3;ctx.strokeStyle='#f19661';ctx.lineWidth=3;ctx.shadowColor='#e16d35';ctx.shadowBlur=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(angle)*length,y+Math.sin(angle)*length);ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#282925';ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();
  }ctx.restore();
}
