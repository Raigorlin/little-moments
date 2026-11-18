// Data-driven storybook poster (storybook-scene-6), module form of demos/storybook-trip-studio/renderer.js.
// Integration changes: blank departure/event/stop times and missing place/vehicle/date references are
// rendered as "未填" instead of throwing; animation ordering uses an internal fallback key that is never printed.
import * as ModelModule from './model.js';
import { StoryArt } from './artwork.js';

const StudioModel=ModelModule.StudioModel||ModelModule.default||ModelModule;
const W=1600,DURATION=16,C={ink:'#3E3A39',paper:'#FFFCF6',teal:'#69A9A0',muted:'#766E63',line:'#DDD5C5',road:'#EADCB8'},cache=new WeakMap();
const TIME_RE=/^([01]\d|2[0-3]):([0-5]\d)$/;
let measuring=null;
const measure=()=>measuring||(measuring=document.createElement('canvas').getContext('2d'));
const mins=t=>{const m=typeof t==='string'?TIME_RE.exec(t):null;return m?Number(m[1])*60+Number(m[2]):null};
const label=v=>v&&typeof v==='object'?(v.label||''):String(v??'');
const evLabel=e=>[e.time,e.title].filter(Boolean).join(' ')||'未命名活動';
const depLabel=r=>r.departure||'出發時間未填';
function dayDate(d){if(!d||!d.date)return'日期未填';try{return StudioModel.dateText(d.date)}catch(_){return d.date}}
function font(c,size,english=false){c.font=`${size}px "${english?'Patrick Hand':'WenKai'}",sans-serif`}
function lines(text,width,size,english=false){const m=measure();font(m,size,english);const out=[];for(const p of String(text||'').split('\n')){let current='';for(const ch of Array.from(p)){if(current&&m.measureText(current+ch).width>width){out.push(current);current=''}current+=ch}out.push(current)}return out}
// Website text may contain tabs/CR/control characters that canvas would draw as boxes.
const clean=v=>String(v??'').replace(/\r\n?/g,'\n').replace(/\t/g,' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'');
function block(raw,x,y,width,size=23,color=C.ink,align='left',english=false){const text=clean(raw);return{text,lines:lines(text,width,size,english),x,y,width,size,color,align,english,lineHeight:Math.ceil(size*1.38)}}
function bh(b){return b.lines.length*b.lineHeight}
function groups(events){const out=[];for(let i=0;i<events.length;i+=2)out.push(events.slice(i,i+2));return out}
function curve(a,b){return[a.x,a.y,a.x+(b.x-a.x)*.42,a.y,a.x+(b.x-a.x)*.65,b.y,b.x,b.y]}
const artMetrics=new Map();
function routeArtBounds(id,options={}){
 const key=id+'|'+JSON.stringify(options);if(artMetrics.has(key))return artMetrics.get(key);
 const ca=document.createElement('canvas');ca.width=800;ca.height=600;const c=ca.getContext('2d',{willReadFrequently:true});let left=800,top=600,right=0,bottom=0;
 for(const t of [0,4,8,12]){c.clearRect(0,0,800,600);StoryArt.draw(c,id,400,350,1,t,options);const a=c.getImageData(0,0,800,600).data;for(let y=0;y<600;y++)for(let x=0;x<800;x++)if(a[(y*800+x)*4+3]>24){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}}
 if(right<left){left=300;right=499;top=250;bottom=399}
 const result={left:left-400,top:top-350,width:right-left+1,height:bottom-top+1};artMetrics.set(key,result);return result;
}
// Ordering key for a route's departure. A blank departure borrows the earliest known time of the day so the
// car still animates in a plausible slot; the key is internal and never rendered as a clock time.
function departureKeys(routes){
 const known=routes.flatMap(r=>[mins(r.departure),...r.stops.map(s=>mins(s.time))]).filter(v=>v!==null),base=known.length?Math.min(...known):0;
 return routes.map(r=>{const own=mins(r.departure);if(own!==null)return own;const first=r.stops.map(s=>mins(s.time)).find(v=>v!==null);return first===undefined?base:Math.min(base,first)});
}
function routeTimeline(routes){
 const keys=departureKeys(routes);
 const chains=routes.map((r,ri)=>{let last=keys[ri];return[{route:ri,stop:-1,key:last,time:r.departure||''},...r.stops.map((s,si)=>{const next=r.stops.slice(si).find(s=>mins(s.time)!==null),limit=next?mins(next.time):last+60;const own=mins(s.time);const key=own!==null?own:last+(limit-last)/2;last=key;return{route:ri,stop:si,key,time:s.time||''}})]});
 const at=chains.map(()=>0),order=[];while(true){const ready=chains.map((c,i)=>c[at[i]]).filter(Boolean);if(!ready.length)break;ready.sort((a,b)=>a.key-b.key||a.stop-b.stop||a.route-b.route);const n=ready[0];order.push(n);at[n.route]++}
 const groups=[];for(const e of order){let g=groups.at(-1);if(!g||g.key!==e.key||g.events.some(x=>x.route===e.route)){g={key:e.key,events:[]};groups.push(g)}g.events.push(e)}
 const step=groups.length>1?10.8/(groups.length-1):0;groups.forEach((g,i)=>g.events.forEach(e=>e.at=1+i*step));
 return{actions:order,stops:order.filter(e=>e.stop>=0),routes:routes.map((r,i)=>({depart:order.find(e=>e.route===i&&e.stop===-1).at,stops:r.stops.map((_,j)=>order.find(e=>e.route===i&&e.stop===j).at)}))};
}
function timedState(m,t){
 const u=((t%DURATION)+DURATION)%DURATION,tl=m.timeline,first=m.curves[0],last=m.curves.at(-1),alpha=Math.max(0,Math.min(1,u/.35,(DURATION-u)/.5));
 const base={day:m.day,vehicleId:m.vehicleId,stopIndex:-1,progress:0,alpha};
 if(u<tl.depart)return{...base,x:first[0],y:first[1],status:'waiting'};
 let from=0,start=tl.depart;
 for(let i=0;i<=m.stopNodes.length;i++){
  const endNode=i<m.stopNodes.length?m.stopNodes[i]:m.curves.length,endTime=i<tl.stops.length?tl.stops[i]:tl.arrive;
  if(u<endTime&&endNode>from){const q=Math.max(0,Math.min(.999999,(u-start)/(endTime-start))),span=endNode-from,k=from+Math.floor(q*span),f=q*span-Math.floor(q*span),e=m.linear?f:f*f*(3-2*f),a=m.curves[k];return{...base,x:cubic(a[0],a[2],a[4],a[6],e),y:cubic(a[1],a[3],a[5],a[7],e),status:'driving',progress:(k+f)/m.curves.length}}
  if(i<m.stopNodes.length){const next=i+1<tl.stops.length?tl.stops[i+1]:tl.arrive,hold=Math.min(.5,Math.max(.05,(next-endTime)*.3)),a=m.curves[endNode-1];if(u<endTime+hold)return{...base,x:a[6],y:a[7],status:'stopping',stopIndex:i,progress:endNode/m.curves.length};start=endTime+hold;from=endNode}
 }
 return{...base,x:last[6],y:last[7],status:'arrived',progress:1};
}

function smoothCurves(pts){const out=[];for(let i=0;i<pts.length-1;i++){const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];out.push([p1.x,p1.y,p1.x+(p2.x-p0.x)/6,p1.y+(p2.y-p0.y)/6,p2.x-(p3.x-p1.x)/6,p2.y-(p3.y-p1.y)/6,p2.x,p2.y])}return out}
function layout(input){
 const p=StudioModel.validate(input),texts=[],days=[],art=[],motions=[],roads=[],pmap=new Map(p.places.map(v=>[v.id,v])),vmap=new Map(p.vehicles.map(v=>[v.id,v]));
 const place=id=>pmap.get(id)||{id,name:'未指定地點',templateId:'home'},veh=id=>vmap.get(id)||{id,name:'未指定車輛',color:'#83accc'};
 const add=(s,x,y,w,size=23,col=C.ink,align='left',en=false)=>{const b=block(s,x,y,w,size,col,align,en);texts.push(b);return b};
 const paint=(id,x,y,s=1,options={})=>art.push({id,x,y,s,options});
 const count=p.vehicles.length+' 台車';
 const dated=p.days.map(d=>d.date).filter(Boolean),range=dated.length?dated[0].replaceAll('-','.')+(dated.length>1?' 至 '+dated.at(-1).replaceAll('-','.'):''):'日期未填';
 add('A LITTLE TRIP INTO THE HILLS',64,46,900,23,C.teal,'left',true);
 const title=add(p.headline||p.title||'未命名旅程',58,119,1050,65);let headExtra=Math.max(0,bh(title)-90);
 const subtitle=add((p.title||'未命名旅程')+'  /  '+range,67,165+headExtra,980,23,C.muted);headExtra+=Math.max(0,bh(subtitle)-32);
 paint('header-scene',0,0);roads.push({d:`M69 ${181+headExtra}q191 7 358-1`,color:'#DD775F',width:4});
 let top=200+headExtra;
 const sorted=d=>{const keys=departureKeys(d.routes);return d.routes.map((r,i)=>({...r,index:i,key:keys[i]})).sort((a,b)=>a.key-b.key||a.index-b.index)};
 function motion(r,points,stopNodes,di,rank,scale=.62,smooth=false){motions.push({day:di,vehicleId:r.vehicleId,color:veh(r.vehicleId).color,departure:r.departure,rank,lane:r.index||0,scale,linear:smooth,curves:smooth?smoothCurves(points):points.slice(1).map((v,i)=>curve(points[i],v)),stopNodes,stops:r.stops})}
 function heading(d,t){const b=add(d.title||dayDate(d),156,t+45,1300,32);const extra=Math.max(0,bh(b)-45);add(dayDate(d)+'  ·  '+place(d.locationId).name,158,t+72+extra,1300,19,C.muted);return extra}
 function summary(events,x,y,width,size=22){let yy=y;for(let i=0;i<events.length;i+=2){const own=events.slice(i,i+2),b=add(own.map(evLabel).join(' · '),x,yy,width,size,C.ink,'center');yy+=bh(b);for(const e of own)if(e.notes){const n=add(e.notes,x,yy,width,size-2,C.muted,'center');yy+=bh(n)}}return yy}
  function journey(d,t,di,rts,{events=true,winding=false}={}){
   const roadMark=roads.length;
   const timing=routeTimeline(rts),originIds=[...new Set(rts.map(r=>r.from))],destIds=[...new Set(rts.map(r=>r.to))];
   const groups=timing.stops.length?Array.from({length:Math.ceil(timing.stops.length/4)},(_,i)=>timing.stops.slice(i*4,i*4+4)):[[]];winding=winding&&groups.length===1;
   // Regular S-road: H equal half-waves between WX0 and WX1, amplitude WA; stop i sits on the crest of half-wave i
   // (even crests above the road, odd crests below). Sampled every 1/6 half-wave so Catmull-Rom stays smooth.
   const WN=groups[0].length,WX0=460,WX1=1180,WA=78,WH=WN<=1?3:WN===2?4:WN,WW=(WX1-WX0)/WH,WS=6,WLEAD=70;
   // crest that stop i sits on; odd crests are below the road
   const crestOf=i=>WN<=1?1:WN===2?[0,3][i]:i,lowAt=i=>crestOf(i)%2===1;
   // The road starts half a wave early, at a flat trough, so cars join it heading right with no corner.
   const sCurve=(cy,upTo=WH*WS)=>Array.from({length:upTo+WS/2+1},(_,k)=>{const x=WX0+(k-WS/2)*WW/WS;return{x,y:cy-WA*Math.sin(Math.PI*(x-WX0)/WW)}});const t0x=Math.min(470,380+.5*(790/Math.max(1,groups[0].length))-45);const feeders=[],endParks=[];
   const originX=173,destX=1397,rows=[],nodes=new Map(),originAnchors=new Map(),destAnchors=new Map();
   const FOOTPRINT={width:182,height:132};
   function picture(id,x,base,options={},role='stop'){
    const b=routeArtBounds(id,options),scale=Math.min(FOOTPRINT.width/b.width,FOOTPRINT.height/b.height),drawX=x-(b.left+b.width/2)*scale,drawY=base-(b.top+b.height)*scale;
    paint(id,drawX,drawY,scale,options);Object.assign(art.at(-1),{routeRole:role,box:{x:x-FOOTPRINT.width/2,y:base-FOOTPRINT.height,...FOOTPRINT}});
   }
   function stopLabel(e,x,y,width){
    const r=rts[e.route],st=r.stops[e.stop];let yy=y;
    const tm=add(st.time||'時間未填',x,yy,width,23,st.time?C.ink:C.muted,'center');yy+=bh(tm);
    const kind=add((e.stop+1)+'. '+label(StudioModel.STOP_KINDS[st.kind]||st.kind),x,yy,width,19,C.ink,'center');yy+=bh(kind);
    const pl=add(place(st.placeId).name,x,yy,width,19,C.muted,'center');yy+=bh(pl);
    const car=add(veh(r.vehicleId).name,x,yy,width,17,C.muted,'center');yy+=bh(car);
    if(st.items&&st.items.length){const b=add(st.items.join('、'),x,yy,width,17,C.muted,'center');yy+=bh(b)}
    if(st.notes){const b=add(st.notes,x,yy,width,17,C.muted,'center');yy+=bh(b)}
    return yy;
   }
   let originY=t+117,originBottom=originY,sharedBase=t+307;
   if(originIds.length===1){
    const id=originIds[0],pl=place(id);let yy=originY;
    const name=add(pl.name+' 出發',originX,yy,220,23,C.ink,'center');yy+=bh(name)+8;
    for(const r of rts){const n=add(depLabel(r)+'  '+veh(r.vehicleId).name,originX,yy,218,19,r.departure?C.ink:C.muted,'center');roads.push({d:`M68 ${yy-6}h.01`,color:veh(r.vehicleId).color,width:7});yy+=bh(n)}
    sharedBase=Math.max(sharedBase,yy+144);picture('route-place',originX,sharedBase,{templateId:pl.templateId},'origin');
    originAnchors.set(id,{x:originX,y:sharedBase+56});originBottom=sharedBase+86;
   }else{
    for(const id of originIds){let yy=originY;const own=rts.filter(r=>r.from===id),pl=place(id);
     const name=add(pl.name,originX,yy,218,19,C.muted,'center');yy+=bh(name);
     for(const r of own){const n=add(depLabel(r)+' '+veh(r.vehicleId).name,originX,yy,218,19,r.departure?C.ink:C.muted,'center');yy+=bh(n)}
     originAnchors.set(id,{x:325,y:yy-23});originY=yy+18;
    }originBottom=originY;sharedBase=Math.max(sharedBase,originBottom-66);
   }
   let rowTop=sharedBase-190;
   const destLabelsTop=t+117;
   for(let rowIndex=0;rowIndex<groups.length;rowIndex++){
    // winding (first day): the road is an S-curve; even stops stand above it, odd stops below it, evenly spaced along it.
    const own=groups[rowIndex],A=winding?WA:0,lane=winding?0:16,laneSpan=(rts.length-1)*lane,capW=Math.min(600,790/Math.max(1,own.length)-16);
    // winding: a stop drawn above the road gets its caption above the picture, a stop below the road gets it below.
    // Measure the upper captions first so the row is pushed down far enough to fit them.
    const capHeight=e=>{const mark=texts.length,h=stopLabel(e,0,0,capW);texts.splice(mark);return h};
    const upperH=winding?Math.max(0,...own.filter((_,i)=>!lowAt(i)).map(capHeight)):0;
    const base=rowTop+190+(upperH?upperH+12:0),roadBase=winding?base+14+A:base+56;
    const lowBase=roadBase+A+laneSpan+14+FOOTPRINT.height,captionY=winding?lowBase+24:roadBase+(rts.length-1)*16+42;
    let bottom=winding?(own.some((_,i)=>lowAt(i))?captionY+24:roadBase+A+laneSpan+40):captionY+24;
    own.forEach((e,i)=>{
     const x=winding?WX0+(crestOf(i)+.5)*WW:380+(i+.5)*(790/Math.max(1,own.length)),r=rts[e.route],st=r.stops[e.stop],pl=place(st.placeId);
     const usePlace=st.kind==='shopping'||st.kind==='waypoint',id=usePlace?'route-place':st.kind,options=usePlace?{templateId:pl.templateId}:{};
     const low=winding&&lowAt(i);
     picture(id,x,low?lowBase:base,options);const point={x,y:winding?roadBase+(low?A:-A)+e.route*lane:roadBase+e.route*16,row:rowIndex};nodes.set(e.route+':'+e.stop,point);
     if(!winding)roads.push({d:`M${x} ${point.y}h.01`,color:veh(r.vehicleId).color,width:10});
     if(winding&&!low){const h=capHeight(e);stopLabel(e,x,base-FOOTPRINT.height-h-6+18,capW)}
     else bottom=Math.max(bottom,stopLabel(e,x,captionY,capW));
    });
    const row={top:rowTop,base,roadBase,bottom:bottom+18};rows.push(row);rowTop=row.bottom+42;
   }
   let destBottom=destLabelsTop;
   const arrivalLabel=d.arrivalLabel||'';
   for(let i=0;i<destIds.length;i++){
    const id=destIds[i],pl=place(id);let yy=i===0?destLabelsTop:destBottom+55;
    const name=add(pl.name, destX,yy,278,23,C.teal,'center');yy+=bh(name);
    if(destIds.length===1&&arrivalLabel){const a=add(arrivalLabel,destX,yy,278,20,C.ink,'center');yy+=bh(a)}
    const base=Math.max(rows[0].base,yy+148);picture('route-place',destX,base,{templateId:pl.templateId},'destination');
    destAnchors.set(id,{x:destX,y:base+56+i*16});
    let textY=Math.max(base+104,rows[0].roadBase+(rts.length-1)*16+55);
    if(events&&i===0)textY=summary(d.events,destX,textY,278,20);
    const arrivalMatch=arrivalLabel.match(/([0-2]?\d):([0-5]\d)/),known=[...rts.map(r=>mins(r.departure)),...rts.flatMap(r=>r.stops.map(s=>mins(s.time)))].filter(v=>v!==null),lastKnown=known.length?Math.max(...known):-Infinity;
    if(i===0&&arrivalMatch&&Number(arrivalMatch[1])*60+Number(arrivalMatch[2])<lastKnown){const warn=add('會合時間早於部分出發／停靠時間，請確認。',destX,textY+10,278,17,'#AC684D','center');textY+=bh(warn)+10}
    destBottom=textY+15;
   }
   const rkeys=timing.routes;
   rts.forEach((r,ri)=>{
    const start=originAnchors.get(r.from),destination=destAnchors.get(r.to);
    const fromPeers=rts.filter(v=>v.from===r.from),fromIndex=fromPeers.indexOf(r),toPeers=rts.filter(v=>v.to===r.to),toIndex=toPeers.indexOf(r);
    const startPark=winding?{x:start.x,y:start.y}:{x:start.x+((fromPeers.length-1)/2-fromIndex)*56,y:start.y},endPark={x:destination.x+((toPeers.length-1)/2-toIndex)*56,y:destination.y};
    const points=[{...startPark}],stopNodes=[];let exitFrom=-1;
    let currentRow=0;
    const laneY=row=>rows[row].roadBase+ri*(winding?0:16);
    if(!winding)points.push({x:363,y:start.y},{x:378,y:laneY(0)});
    for(let si=0;si<(winding?0:r.stops.length);si++){
     const target=nodes.get(ri+':'+si);
     while(currentRow<target.row){points.push({x:1200+ri*8,y:laneY(currentRow)},{x:1200+ri*8,y:rows[currentRow].bottom+46+ri*12},{x:333-ri*8,y:rows[currentRow].bottom+46+ri*12});currentRow++;points.push({x:333-ri*8,y:laneY(currentRow)})}
     stopNodes.push(points.length);points.push({...target});
    }
    const sameEnd=r.stops.length&&r.stops.at(-1).placeId===r.to;
    if(winding){const own=groups[0],endAt=sameEnd?own.findIndex(e=>e.route===ri&&e.stop===r.stops.length-1):-1;
     const lead={x:WX0-WW/2,y:laneY(0)+WA};points.push({x:startPark.x+(lead.x-startPark.x)*.15,y:lead.y-Math.min(60,Math.max(0,(lead.y-startPark.y)*.35))});
     const base0=points.length+WS/2,road=sCurve(laneY(0),endAt>=0?crestOf(endAt)*WS+WS/2:WH*WS);points.push(...road);
     own.forEach((e,i)=>{if(e.route===ri&&(endAt<0||i<=endAt))stopNodes.push(base0+crestOf(i)*WS+WS/2)});}
    if(!sameEnd){
     if(winding){
      // Exit to this car's own destination. A destination far below the road gets a branch that runs down at x≈1200,
      // left of the destination text column, then turns into the parking spot.
      exitFrom=points.length-1;
      if(Math.abs(endPark.y-laneY(0))>110){const dn=endPark.y>laneY(0)?1:-1;points.push({x:1195+ri*6,y:laneY(0)+dn*60},{x:1205+ri*6,y:endPark.y-dn*60})}
      points.push({...endPark});
     }else{const right=1210+ri*4;points.push({x:right,y:laneY(currentRow)},{x:right,y:endPark.y},{...endPark});}
    }
    motion(r,points,stopNodes,di,ri,.56,winding);const m=motions.at(-1),tl=rkeys[ri];m.timeline={...tl,arrive:sameEnd?tl.stops.at(-1)+.5:Math.min(14.2,(tl.stops.at(-1)??tl.depart)+1.8)};m.originId=r.from;m.destinationId=r.to;
    if(winding){feeders.push(m.curves.slice(0,2));if(!sameEnd&&exitFrom>=0)feeders.push(m.curves.slice(exitFrom));endParks.push(endPark);m.trail=true}
    else for(const a of m.curves)roads.push({d:`M${a[0]} ${a[1]}C${a.slice(2).join(' ')}`,color:C.road,width:10});
   });
   // One smooth trunk road for the whole first day: wide band with a dashed centre line; each car joins it from its parking spot.
   if(winding){
    // The trunk is the regular S-curve; every car's own exit (to its own destination) is drawn as a branch road.
    const cy=rows[0].roadBase,pts=sCurve(cy);
    const path=cs=>cs.map((a,i)=>(i?'':`M${a[0]} ${a[1]}`)+`C${a.slice(2).join(' ')}`).join(''),trunk=path(smoothCurves(pts)),feeder=feeders.map(a=>path(a));
    roads.splice(roadMark,0,{d:trunk,color:'#D4C193',width:54},...feeder.map(d=>({d,color:'#D4C193',width:36})),{d:trunk,color:'#F1E6C6',width:46},...feeder.map(d=>({d,color:'#F1E6C6',width:28})),{d:trunk,color:'#FFFCF6',width:3,dash:[16,14]});
   }
   return Math.max(rows.at(-1).bottom+(rows.length>1?130:0),originBottom,destBottom)+34;
  }
  function arrival(d,t,di){return journey(d,t,di,sorted(d),{winding:true})}
  function errands(d,y,di,routes){return routes.length?journey(d,y-85,di,routes,{events:false,winding:true}):y}

 function campDay(d,t){
  const gs=groups(d.events);if(!gs.length){paint('camp-scene',950,t+220,.8,{templateId:place(d.locationId).templateId});add('這一天留白，慢慢安排。',65,t+140,640,24,C.muted);return t+280}
  let y=t+84;const xs=[225,596,989,1396];for(let offset=0;offset<gs.length;offset+=4){const own=gs.slice(offset,offset+4);let end=y+210;own.forEach((group,i)=>{const x=xs[i],k=group.map(e=>e.kind),id=k.includes('breakfast')?'breakfast-scene':k.includes('explore')&&k.includes('noodles')?'photo-noodles':k.includes('hotpot')||k.includes('games')?'table-scene':k.includes('night')?'night-scene':k.includes('cleanup')?'cleanup-scene':k[0];paint(id,x,y+110,1);let ty=y+142;if(k.includes('sunrise')&&k.includes('breakfast'))ty=summary(group,x,ty,340,21);else{for(const e of group){const b=add(evLabel(e),x,ty,340,21,C.ink,'center');ty+=bh(b);if(e.notes){const n=add(e.notes,x,ty,340,18,C.muted,'center');ty+=bh(n)}}}end=Math.max(end,ty+18)});y=end+8}return y;
 }
 function returnDay(d,t,di){
  const special=d.events.every(e=>['sunrise','breakfast','pack','cleanup','depart'].includes(e.kind));
  if(!special){const end=campDay(d,t);return errands(d,end,di,sorted(d));}
  const breakfast=d.events.filter(e=>['sunrise','breakfast'].includes(e.kind)),pack=d.events.filter(e=>e.kind==='pack'),cleanup=d.events.filter(e=>e.kind==='cleanup'),depart=d.events.filter(e=>e.kind==='depart');
  let end=t+246;
  if(breakfast.length){let yy=t+122;const b=add(breakfast.map(evLabel).join(' · '),65,yy,390,22);yy+=bh(b);for(const e of breakfast)if(e.notes){const n=add(e.notes,65,yy,390,19,C.muted);yy+=bh(n)}paint('return-breakfast',220,Math.max(t+218,yy+52));end=Math.max(end,yy+83)}
  if(pack.length){paint('pack',569,t+155,1);end=Math.max(end,summary(pack,575,t+207,310,21)+20)}
  if(cleanup.length){paint('cleanup-scene',844,t+159,1);end=Math.max(end,summary(cleanup,844,t+207,310,21)+20)}
  const rts=sorted(d),simple=rts.length&&rts.every(r=>!r.stops.length)&&new Set(rts.map(r=>r.to)).size===1;
  if(simple){const r=rts[0],pl=place(r.to),lbl=depart.length?depart.map(evLabel).join(' · '):rts.map(r=>depLabel(r)+' '+veh(r.vehicleId).name).join(' / ');const b=add(lbl,1192,t+77,630,23,C.ink,'center');const roadY=Math.max(t+173,t+77+bh(b)+57);roads.push({d:`M1024 ${roadY}Q1190 ${roadY+28} 1391 ${roadY-21}`,color:'#E9D8AF',width:33});const tls=routeTimeline(rts).routes;rts.forEach((r,i)=>{motion(r,[{x:1030+i*52,y:roadY-2},{x:1370-(rts.length-1-i)*52,y:roadY-13}],[],di,i,.53);const m=motions.at(-1),tl=tls[i];m.timeline={...tl,arrive:Math.min(14.2,tl.depart+1.8)};m.originId=r.from;m.destinationId=r.to});paint(pl.templateId,1480,roadY-7,.76);const home=add(pl.name,1453,roadY+40,265,24,C.teal,'center');end=Math.max(end,roadY+40+bh(home)+10)}
  else{paint('home',1400,t+186,.85);add(depart.length?depart.map(evLabel).join(' · '):'收營後，各自平安回家。',1260,t+91,530,23,C.ink,'center');const note=add(d.arrivalLabel||'歸還與接送，依各車安排。',1260,t+224,530,19,C.muted,'center');end=Math.max(end,t+224+bh(note)+14);end=errands(d,end+12,di,rts)}
  return end;
 }
 if(!p.days.length){add('還沒有任何日子。新增第一天後，海報就會開始長出來。',65,top+60,1400,24,C.muted);top+=120}
 for(let di=0;di<p.days.length;di++){const d=p.days[di],start=top,extra=heading(d,top);const t=top+extra;let end;if(d.routePosition==='after'&&d.routes.length)end=returnDay(d,t,di);else if(d.routes.length)end=arrival(d,t,di);else end=campDay(d,t);top=end+8;days.push({index:di,start,end:top,title:d.title,badgeY:start+22});}
 if(p.shopping&&p.shopping.length){const b=add('未分配採買清單：'+p.shopping.join(' · '),65,top+24,1460,18,C.muted);top+=bh(b)+33}
 const foot=add(p.caption||count+'，一整頁的小小快樂。',65,top+25,760,18,C.muted);const disclaimer=add('路線僅為示意，非導航或即時位置；不預估返抵時間。',1537,top+25,705,17,C.muted,'right');top+=Math.max(bh(foot),bh(disclaimer))+35;
 return{width:W,height:Math.ceil(top),duration:DURATION,days,texts,art,motions,roads,plan:p};
}
function text(c,b){font(c,b.size,b.english);c.fillStyle=b.color;c.textAlign=b.align;b.lines.forEach((s,i)=>c.fillText(s,b.x,b.y+i*b.lineHeight))}
function stroke(c,d,col,width,dash){c.strokeStyle=col;c.lineWidth=width;c.setLineDash(dash||[]);c.stroke(new Path2D(d));if(dash)c.setLineDash([])}
// Dashed trail behind a car: whole curves already driven plus the driven part of the current one (de Casteljau split).
function trail(c,m,amount,alpha){
 const n=Math.max(0,Math.min(m.curves.length,amount));if(n<=0)return;
 const p=new Path2D(),full=Math.floor(n),u=n-full;p.moveTo(m.curves[0][0],m.curves[0][1]);
 for(let i=0;i<full;i++){const a=m.curves[i];p.bezierCurveTo(a[2],a[3],a[4],a[5],a[6],a[7])}
 if(u>0&&full<m.curves.length){const a=m.curves[full],L=(x,y)=>x+(y-x)*u;
  const x01=L(a[0],a[2]),y01=L(a[1],a[3]),x12=L(a[2],a[4]),y12=L(a[3],a[5]),x23=L(a[4],a[6]),y23=L(a[5],a[7]);
  const xa=L(x01,x12),ya=L(y01,y12),xb=L(x12,x23),yb=L(y12,y23);p.bezierCurveTo(x01,y01,xa,ya,L(xa,xb),L(ya,yb))}
 c.save();c.globalAlpha=Math.max(.35,alpha);c.lineCap='round';c.lineJoin='round';
 c.setLineDash([10,10]);c.lineWidth=7;c.strokeStyle='#FFFCF6';c.stroke(p);
 c.setLineDash([10,10]);c.lineWidth=5;c.strokeStyle=m.color;c.stroke(p);c.restore();
}
function cubic(a,b,c,d,t){const q=1-t;return a*q*q*q+3*b*q*q*t+3*c*q*t*t+d*t*t*t}
function state(m,t){if(m.timeline)return timedState(m,t);const u=((t-m.rank*1.6)%DURATION+DURATION)%DURATION,drive=9/m.curves.length,hold=m.stopNodes.length?3/m.stopNodes.length:0;let elapsed=u,point=null,status='arrived',stopIndex=-1,progress=1;for(let i=0;i<m.curves.length;i++){if(elapsed<drive){const a=m.curves[i],f=elapsed/drive,e=m.linear?f:f*f*(3-2*f);point={x:cubic(a[0],a[2],a[4],a[6],e),y:cubic(a[1],a[3],a[5],a[7],e)};status='driving';progress=(i+f)/m.curves.length;break}elapsed-=drive;const st=m.stopNodes.indexOf(i+1);if(st!==-1){if(elapsed<hold){const a=m.curves[i];point={x:a[6],y:a[7]};status='stopping';stopIndex=st;progress=(i+1)/m.curves.length;break}elapsed-=hold}}if(!point){const a=m.curves.at(-1);point={x:a[6],y:a[7]}}const length=9+(m.stopNodes.length?3:0),alpha=Math.max(0,Math.min(1,u/.4,(length+.5-u)/.5));return{...point,day:m.day,vehicleId:m.vehicleId,status,stopIndex,progress,alpha}}
function staticLayer(l){if(cache.has(l))return cache.get(l);const ca=document.createElement('canvas'),scale=Math.min(1,Math.sqrt(12_000_000/(W*l.height)),16000/l.height);ca.width=Math.max(1,Math.floor(W*scale));ca.height=Math.max(1,Math.floor(l.height*scale));const c=ca.getContext('2d');c.scale(ca.width/W,ca.height/l.height);c.fillStyle=C.paper;c.fillRect(0,0,W,l.height);c.lineCap='round';c.lineJoin='round';let seed=37211;for(let i=0;i<8500*l.height/1200;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const x=seed/4294967296*W;seed=(Math.imul(seed,1664525)+1013904223)>>>0;c.fillStyle='rgba(131,108,61,.025)';c.fillRect(x,seed/4294967296*l.height,1.2,1.2)}
for(const d of l.days){c.save();c.translate(94,d.start+47);c.rotate(-.055);c.fillStyle=['#F0CCA3','#D5E5D4','#ECDC9F'][d.index%3];const shape=new Path2D('M-28-27Q-1-35 28-27L33 25Q4 33-29 25Z');c.fill(shape);c.strokeStyle=C.ink;c.lineWidth=3;c.stroke(shape);font(c,44,true);c.textAlign='center';c.fillStyle=C.ink;c.fillText(String(d.index+1).padStart(2,'0'),0,16);c.restore();stroke(c,`M58 ${d.end-5}Q260 ${d.end-15} 447 ${d.end-9}T809 ${d.end-8}T1160 ${d.end-3}T1542 ${d.end-11}`,C.line,1.8)}
for(const r of l.roads)stroke(c,r.d,r.color,r.width,r.dash);
for(const m of l.motions){for(const a of m.curves)stroke(c,`M${a[0]} ${a[1]}C${a.slice(2).join(' ')}`,m.color,2);const a=m.curves.at(-1);c.save();c.setLineDash([10,10]);stroke(c,`M${a[0]} ${a[1]+7}C${a[2]} ${a[3]+7} ${a[4]} ${a[5]+7} ${a[6]} ${a[7]+7}`,'#927F65',1.8);c.restore()}
for(const b of l.texts)text(c,b);cache.set(l,ca);return ca}
function draw(canvas,plan,l,t=0){l=l||layout(plan);const c=canvas.getContext('2d'),tm=((Number.isFinite(t)?t:0)%DURATION+DURATION)%DURATION;c.save();try{c.setTransform(canvas.width/W,0,0,canvas.height/l.height,0,0);c.clearRect(0,0,W,l.height);c.drawImage(staticLayer(l),0,0,W,l.height);for(const a of l.art)StoryArt.draw(c,a.id,a.x,a.y,a.s,tm,a.options);const vehicles=[];for(const m of l.motions)if(m.trail){const s=state(m,tm);trail(c,m,s.progress*m.curves.length,s.alpha)}for(const m of l.motions){const s=state(m,tm);StoryArt.draw(c,'car',s.x,s.y-8,m.scale,tm,{color:m.color,alpha:s.alpha});vehicles.push(s)}return{time:tm,width:W,height:l.height,days:l.days.length,labels:l.texts.map(v=>v.text),vehicles}}finally{c.restore()}}
export const StudioRenderer=Object.freeze({VERSION:'storybook-scene-6',duration:DURATION,layout,draw,lines,state,routeTimeline});
