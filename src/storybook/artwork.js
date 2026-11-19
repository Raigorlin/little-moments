// Hand-drawn storybook artwork (storybook-art-5), unchanged drawing code; module form of demos/storybook-trip-studio/artwork.js.
const DURATION=16,TAU=Math.PI*2;
const C={ink:'#493E34',paper:'#FCF6E8',red:'#DD775F',yellow:'#E7B84D',teal:'#69A9A0',blue:'#83ACCC',leaf:'#7EA079',pale:'#DFE9D5',rose:'#F2D9C7',cream:'#F5DC97',night:'#657D95'};
let c,time,phase,labels=[];
const wave=(n=1,offset=0)=>Math.sin(phase*TAU*n+offset),clamp=v=>Math.min(1,Math.max(0,v));
function shape(d,fill,stroke=C.ink,width=3){const p=new Path2D(d);if(fill){c.fillStyle=fill;c.fill(p)}if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke(p)}}
function line(d,color=C.ink,width=2.6){shape(d,null,color,width)}
function oval(x,y,rx,ry,fill,stroke=C.ink,width=2.6){c.beginPath();c.ellipse(x,y,rx,ry,0,0,TAU);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke()}}
function box(x,y,w,h,r,fill,stroke=C.ink,width=2.6){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke()}}
function local(x,y,scale,rotation,fn){c.save();c.translate(x,y);c.scale(scale,scale);c.rotate(rotation);fn();c.restore()}
function txt(s,x,y,size=22,color=C.ink,align='left',english=false){c.fillStyle=color;c.textAlign=align;c.font=`${size}px "${english?'Patrick Hand':'jf open 粉圓'}",sans-serif`;c.fillText(s,x,y);const w=c.measureText(s).width;labels.push({s,x:x-(align==='center'?w/2:align==='right'?w:0),y:y-size,w,h:size})}
function grass(x,y,s=1){local(x,y,s,0,()=>line('M-9 0q-2-8-7-10M-2 0q1-11 5-15M6 0q5-8 10-8',C.leaf,2))}
function sparkle(x,y,s=1,col=C.yellow){local(x,y,s,0,()=>{shape('M0-10Q2-2 9 0Q2 2 0 10Q-2 2-9 0Q-2-2 0-10Z',col,null)})}
function cloud(x,y,s=1){local(x+wave(1,x)*8,y,s,0,()=>{shape('M-59 14Q-78 12-71-4Q-66-19-46-15Q-52-43-27-46Q-4-50 5-27Q24-44 41-28Q50-20 46-9Q78-13 74 9Q73 22 45 21L-50 22Z','#FFFCF3','#DDD4BF',1.8);line('M-49 26q53 5 95-1','#E4DDCA',1.1)})}
function pine(x,y,s=1,col=C.leaf){local(x,y,s,wave(1,x)*.01,()=>{line('M0 0q1-45 0-100','#90775A',6);shape('M-31-30Q-24-43-20-56L-33-53Q-12-77-10-85L-23-84Q-6-101 0-130Q8-105 24-83L11-85Q19-65 32-54L21-56Q31-38 37-28Q2-20-31-30Z',col);line('M0-112v79M0-68l-12-8M1-50l16-10','#5E7C60',1.5)})}
function tree(x,y,s=1){local(x,y,s,wave(1,x)*.01,()=>{line('M0 0v-60','#987958',7);shape('M-31-40Q-58-48-42-70Q-60-91-34-107Q-26-132-4-119Q21-135 34-110Q63-103 44-80Q60-53 29-45Q5-25-31-40Z','#B7CCA3',C.ink,2.5);line('M0-33v-65M0-60l-19-16M0-46l22-25','#768D65',2)})}
function face(x,y,s=1,smile=true){local(x,y,s,0,()=>{oval(-10,0,2.6,3.5,C.ink,null);oval(10,0,2.6,3.5,C.ink,null);oval(-19,9,6,3.5,'#EBAA92',null);oval(19,9,6,3.5,'#EBAA92',null);if(smile)line('M-5 10q5 6 10 0',C.ink,2.2)})}
function sun(x,y){local(x,y,1,wave()*.025,()=>{for(let i=0;i<12;i++)local(0,0,1,i*TAU/12,()=>line('M0-67q-2-9 0-15',C.yellow,4));oval(0,0,56,54,C.yellow,C.ink,3);face(0,-4,1.3);line('M-26 27q26 9 52 0','#D3A449',1.5)})}
function bear(x,y,s=1,color=C.teal,pose='wave',rabbit=false){local(x,y,s,0,()=>{
 oval(0,2,36,8,'#DAD9BC',null);
 if(rabbit){oval(-13,-91,8,22,'#F4E6CD');oval(13,-91,8,22,'#F4E6CD');line('M-13-105v22M13-105v22','#D9B9A5',2)}else{oval(-22,-76,11,11,'#C49A70');oval(22,-76,11,11,'#C49A70');oval(-22,-76,5,5,'#E4BD97',null);oval(22,-76,5,5,'#E4BD97',null)}
 shape('M-22-44Q-33-25-26-2L-8-1L0-16L8-1H26Q31-26 20-44Z',color);
 oval(0,-58,32,28,rabbit?'#F4E6CD':'#D4B18A');oval(0,-50,15,11,'#F7E4C7',null);oval(-10,-62,2.5,3,C.ink,null);oval(10,-62,2.5,3,C.ink,null);oval(0,-53,3.4,2.3,C.ink,null);line('M0-50v4m-5-1q5 5 10 0',C.ink,1.7);oval(-21,-51,5,3,'#E4A38C',null);oval(21,-51,5,3,'#E4A38C',null);
 line('M-9-37v19M9-37v19','#F4E6CD',2);oval(-17,-1,11,6,'#A88769');oval(17,-1,11,6,'#A88769');
 if(pose==='wave')local(25,-34,1,-.65+wave(2,x)*.16,()=>{box(-6,-23,12,32,6,rabbit?'#F4E6CD':'#D4B18A');line('M-2-20v3M2-20v3',C.ink,1)})
 else if(pose==='camera'){box(-27,-43,54,30,6,'#EEE0BE');oval(1,-28,11,11,C.night);oval(1,-28,5,5,'#BFD4D1',null);box(14,-48,12,7,2,C.ink);oval(-27,-29,6,7,'#D4B18A');oval(27,-29,6,7,'#D4B18A')}
 else if(pose==='broom'){local(35,-16,1,wave(2)*.06,()=>{line('M0-57L-2 10','#A2835D',4);shape('M-9 9l-9 23q16 7 31 0L7 9Z','#DBB16D');line('M-7 14l-4 14M-1 15v16M5 16l4 14','#A78653',1)})}
 else{line('M-24-33l-10 15M24-33l12 12',rabbit?'#F4E6CD':'#D4B18A',10)}
 })}
function tent(x,y,s=1,color=C.red){local(x,y,s,0,()=>{
 oval(0,0,96,13,'#B8CAA4',null);shape('M-96-5Q-58-77-14-127Q1-134 16-121L91-8Q29 8-96-5Z',color);
 shape('M-14-127Q30-91 91-8L32-2Q2-68-14-127Z','#C65F51');shape('M-69-6Q-48-58-15-95Q12-57 24-3Z','#6C7971');shape('M-69-6Q-40-42-15-95Q-30-31-32-5Z','#F4CC9D');shape('M-15-95Q10-57 24-3L6-6Z','#EFB785');line('M-86-4Q-46-75-14-116Q24-73 40-4','#F7BA9F',2.5);
 line('M-14-128v-27',C.ink,2.5);shape(`M-14-155Q4 ${-160+wave(2)*4} 22-148L-14-139Z`,C.yellow);line('M-80-13L-111 1M75-24L111 1','#7D866D',2);line('M-110-3v9M109-3v9',C.ink,3);box(38,-38,24,14,3,'#F3C8A6');line('M44-35v8M49-35v8M54-35v8','#BE7D67',1.2);
 })}
function flame(x,y,s=1){local(x,y,s,0,()=>{oval(0,7,27,7,'#C4BEA1',null);line('M-20 5l36-12M-18-6l35 13','#967354',7);local(0,0,1+.035*wave(8),wave(4)*.03,()=>{shape('M0 0Q-34-11-13-37Q-7-45-4-58Q3-39 14-35Q40-13 0 0Z','#EB9A53');shape('M0-2Q-15-12-2-30Q3-21 10-16Q16-5 0-2Z','#F6D36D',null)});for(let i=0;i<3;i++){const p=(phase*4+i/3)%1;c.save();c.globalAlpha=(1-p)*.8;oval(Math.sin(p*5+i)*12,-40-p*40,2,3,C.yellow,null);c.restore()}})}
function bunting(x,y,length){line(`M${x} ${y}Q${x+length/2} ${y+35} ${x+length} ${y}`,C.ink,2);for(let i=0;i<8;i++){const f=(i+.5)/8,xx=x+length*f,yy=y+70*f*(1-f);local(xx,yy,1,wave(2,i)*.1,()=>shape('M-9 0H9L1 18Z',[C.red,C.yellow,C.teal][i%3],C.ink,1.8))}}
function steam(x,y,s=1){local(x,y,s,0,()=>{for(let i=0;i<3;i++){const f=(phase*2+i/3)%1;c.save();c.globalAlpha=Math.sin(f*Math.PI)*.65;line(`M${i*13-13} ${-10-f*35}q-9-11 0-18t0-15`,'#ABAB97',2.5);c.restore()}})}
function cup(x,y,s=1){local(x,y,s,0,()=>{oval(0,4,25,5,'#D3CEAF',null);shape('M-18-32H18V-6Q15 5 0 5Q-16 4-18-6Z','#FFFCF1');shape('M19-26Q42-26 34-10Q29-3 19-7',null,C.ink,3);oval(0,-32,18,5,'#8F6950');line('M-9-20v14','#E2D7B9',2);steam(0,-36,.8)})}
function van(x,y,s,color,flip=false,alpha=1){local(x,y,s,flip?Math.PI:0,()=>{c.globalAlpha*=alpha;oval(0,11,39,6,'#C5C4A4',null);local(0,wave(12,x)*.8,1,0,()=>{shape('M-43 4V-26Q-43-38-29-39H15Q26-38 30-26L41-13Q46-10 45 4Z',color);shape('M-34-31H-8V-12H-35Z','#E2EEE1',C.ink,2);shape('M0-31H15Q21-28 26-14H0Z','#E2EEE1',C.ink,2);line('M-21-30v18M-2-6v10',C.ink,1.7);oval(-15,-21,3.3,3.3,'#C69D76',null);line('M4-5h7',C.ink,2);box(32,-6,10,5,2,'#F6DF91',C.ink,1);box(-25,-52,36,12,4,'#C8AA77');line('M-15-51v11M1-51v11',C.ink,1.5);line('M-43 5h88',C.ink,3)});for(const xx of [-25,27]){oval(xx,8,10,10,C.ink);oval(xx,8,4.3,4.3,'#EAD9AB',null);local(xx,8,1,phase*TAU*12,()=>line('M-5 0H5M0-5V5','#EAD9AB',1.4))}})}
function market(x,y,s=1,brand='market'){local(x,y,s,0,()=>{oval(0,3,85,10,'#D4D4B4',null);box(-65,-91,132,91,8,'#F0DFC0');shape('M-78-97Q0-112 81-97L73-70Q0-61-76-70Z','#F4D795');for(let i=0;i<6;i++)shape(`M${-75+i*26}-99L${-59+i*26}-100L${-61+i*26}-69L${-75+i*26}-70Z`,i%2?C.red:'#F7EACB',null);line('M-76-70Q0-61 74-70',C.ink,3);const colors={'seven-eleven':['#478D72','7-ELEVEN'],'familymart':['#528EA2','FamilyMart'],'okmart':['#B96063','OK mart'],'pxmart-mega':['#668FAE','大全聯'],'costco':['#CA6A5A','COSTCO'],'ikea':['#537DAB','IKEA'],'carrefour':['#5D88A6','家樂福']};const br=colors[brand]||[C.teal,'MARKET'];box(-55,-130,112,30,9,br[0]);txt(br[1],1,-109,brand==='familymart'?15:18,brand==='ikea'?'#F2D477':'#FFF7DF','center',true);box(-53,-57,65,33,5,'#AAC6B8');box(25,-60,29,61,4,'#D9E6CF');line('M43-29v7',C.ink,2.2);box(-60,-19,79,23,3,'#B98D5D');for(let i=0;i<7;i++)oval(-52+i*10,-24+(i%2)*4,7,8,[C.red,C.yellow,C.leaf][i%3],C.ink,1.7);line('M-59-8H17','#E4C699',1.5);shape('M81-33L98-28 94-8 80-12Z','#E1DDC5');line('M75-39h5l4 33 14 2',C.ink,2);oval(84,0,3.5,3.5,C.ink,null);oval(95,1,3.5,3.5,C.ink,null)})}
function grocery(x,y,s=1){local(x,y,s,wave(2,x)*.018,()=>{shape('M-27-44L23-41 28 1Q1 9-26 1Z','#C6A774');line('M-12-43q-5-22 14-17q9 2 8 17',C.ink,2);shape('M-20-40Q-25-63-14-64Q0-62-1-42Z','#F1C477');line('M-19-57l9 2M-16-49l11 2','#B79360',2);shape('M8-40L2-62l9 6 8-15 3 30Z',C.leaf);face(0,-17,.5)})}
function breakfast(x,y){local(x,y,1,0,()=>{oval(0,4,99,25,'#E3D7B6',null);oval(-20,-7,63,28,'#FFFBEB');oval(-20,-7,52,21,null,'#CEC7AA',1.5);shape('M-54-18q-7-14 8-21h33q13 8 5 20v33h-46Z','#D19B62');shape('M-48-15q-5-13 9-15h19q11 4 5 14v22h-33Z','#EACB90',null);shape('M-9-5Q-18-22 4-24Q25-33 37-12Q53-1 35 11Q21 25 7 8Q-13 12-9-5Z','#FEF6D9',C.ink,1.8);oval(16,-7,12,9,C.yellow,C.ink,1.4);shape('M-53 19q17-18 38-2l-5 8q-19-12-33 2Z',C.red,C.ink,1.5);cup(88,-3,1);sparkle(-90,-45,.7);sparkle(112,-62,.55)})}
function noodles(x,y,s=1){local(x,y,s,0,()=>{shape('M-43-19Q-38 17 0 19Q36 17 45-19Z','#F0C279');oval(0,-19,45,13,'#F2DB92');for(let i=0;i<5;i++)line(`M${-29+i*12}-22q14-9 15 3q-17 9-24 0`,'#B68E50',1.7);oval(18,-20,11,7,'#FFF7DC',C.ink,1.3);oval(19,-21,5,4,C.yellow,null);line('M-22-29l-14-38M-10-29l-10-41','#967256',3);steam(-6,-37,.7)})}
function pot(x,y,s=1){local(x,y,s,0,()=>{oval(0,8,73,14,'#CDBE9A',null);box(-35,0,71,16,4,C.night);shape('M-60-41L-51-1Q-4 20 51-2L59-41Z',C.red);oval(0,-42,60,15,'#F0CC88');line('M-61-32q-23-8-18 6q5 11 22 8M61-32q23-8 18 6q-5 11-22 8',C.ink,4);for(const [x,y,col]of [[-33,-45,C.leaf],[-13,-35,'#F8E8BC'],[12,-43,C.red],[34,-39,C.leaf]])oval(x,y,10,6,col,C.ink,1.4);steam(0,-51,1.2)})}
function moon(x,y){local(x,y,1,wave()*.025,()=>{shape('M15-45Q-45-58-47 0Q-44 47 9 43Q35 41 46 17Q6 36-10 8Q-27-16 15-45Z','#EED28B');oval(-23,0,2.5,3,C.ink,null);line('M-19 12q5 4 8-1',C.ink,2);oval(-33,10,5,3,'#DFA98A',null)})}
function pack(x,y){local(x,y,1,wave(2)*.012,()=>{oval(0,6,80,13,'#D8D8B9',null);box(-73,-38,95,37,16,'#9CB6A0');oval(-60,-20,10,15,'#C6D4AF');line('M-31-36v35M1-36v35','#6F8B72',4);box(15,-79,53,77,12,C.yellow);box(22,-44,40,30,7,'#F0CE77');line('M29-78q10-18 24 0',C.ink,3);line('M21-67h41M36-67v13M55-67v13',C.ink,2);shape('M-22-56L-6-79 18-55Z',C.red);sparkle(-84,-53,.6)})}
function home(x,y,s=1){local(x,y,s,0,()=>{oval(0,4,58,9,'#D0D4B4',null);box(-42,-73,80,76,5,'#F3DEB1');shape('M-55-72Q-20-105-4-119Q21-99 51-74Z',C.red);box(-13,-40,24,44,8,C.teal);box(-33,-58,20,19,4,'#BDDBD3');box(16,-58,17,19,4,'#BDDBD3');line('M-23-57v16M-31-49h16M24-57v16',C.ink,1.3);oval(5,-18,2,2,C.ink,null);shape('M26-104v-19h13v28',C.red);line('M26-126h16',C.ink,3);grass(-55,1,.7)})}
function badge(n,x,y,col,title,date){local(x,y,1,-.055,()=>{shape('M-28-27Q-1-35 28-27L33 25Q4 33-29 25Z',col);txt(n,0,16,44,C.ink,'center',true)});txt(title,x+62,y-2,32);txt(date,x+64,y+25,18,'#86765E')}
function cubic(p,a,b,d,t){const q=1-t;return q*q*q*p+3*q*q*t*a+3*q*t*t*b+t*t*t*d}
function curvePoint(curve,t){return{x:cubic(curve[0],curve[2],curve[4],curve[6],t),y:cubic(curve[1],curve[3],curve[5],curve[7],t)}}
function route(curve,col,width=7){line(`M${curve[0]} ${curve[1]}C${curve.slice(2).join(' ')}`,col,width)}
function dashed(curve){c.save();c.setLineDash([2,11]);route(curve,'#927F65',2.3);c.restore()}
function bell(x,y,s=1){local(x,y,s,0,()=>{oval(0,0,95,12,'#CBD4AE',null);shape('M-85-7L-63-48-8-140 48-51 79-8Q-5 13-85-7Z','#F2DCAB');shape('M-63-48Q-5-29 48-51L-8-140Z','#FAEBD0');shape('M-19-4V-55Q-6-90 9-55L17-4Z','#897C63');line('M-8-141v-22');shape(`M-8-163q19 ${wave(2)*3} 27 11l-27 9Z`,C.red);line('M-65-46l-34 47M49-47l44 48','#94876B',2);grass(-105,3);cup(103,0,.6)})}
function dome(x,y,s=1){local(x,y,s,0,()=>{oval(0,0,99,11,'#CBD4AE',null);shape('M-93-4Q-106-108-14-120Q72-123 93-6Q0 10-93-4Z','#8DBBB0');shape('M-88-5Q-69-112-14-120Q37-100 32-3Z','#C2D7BA');shape('M-57-4Q-63-82-17-89Q27-87 20-4Z','#627E73');shape('M-57-4Q-63-82-17-89L-29-5Z','#DEDFC2');line('M-93-4Q-79-107-14-120Q62-120 93-6',C.ink,2.8);box(44,-43,24,15,4,'#DBE5C9');line('M47-38h17M47-33h17','#6C8C7C',1.2)})}
function tarp(x,y,s=1){local(x,y,s,0,()=>{oval(0,0,103,11,'#CDD3B1',null);shape('M-96-99L-26-137 97-91 24-52Z','#EACB8B');shape('M-96-99L-26-137 24-52Z','#F6E2B7');line('M-95-99V0M96-91V0M-26-137V-5','#9A7C57',4);box(-41,-50,89,9,3,'#B99264');line('M-30-42L-37-2M37-42L45-2','#866E52',4);cup(0,-48,.65);for(const x of [-73,72]){box(x-14,-53,24,24,3,C.teal);line(`M${x-14}-29l24 27M${x+10}-29l-25 27`,C.ink,3)}})}
function cabin(x,y,s=1){local(x,y,s,0,()=>{oval(0,0,92,10,'#CAD4B5',null);box(-70,-106,141,107,6,'#C5A074');for(let yy=-94;yy<0;yy+=16)line(`M-67 ${yy}H67`,'#967650',1.8);shape('M-89-103L-8-157 91-104Z',C.teal);box(-15,-62,32,62,5,'#6D938C');box(-56,-76,26,25,4,'#DDE9D5');box(31,-76,26,25,4,'#DDE9D5');line('M-43-75v23M44-75v23',C.ink,1.8);box(38,-144,16,27,2,'#A5A89C');steam(40,-139,.6);grass(-89,2,.7)})}
function camper(x,y,s=1){local(x,y,s,0,()=>{van(-5,-16,1.7,C.teal);shape('M-54-71H45L82-44H-43Z','#EFD49C');line('M-43-44V0M81-44V0','#947550',3);cup(58,-2,.55);grass(-80,2,.7)})}
function grill(x,y,s=1){local(x,y,s,0,()=>{oval(0,2,68,10,'#DAD1AE',null);shape('M-52-55Q-42-5 0-7Q44-10 51-55Z',C.red);oval(0,-55,53,14,'#756A59');for(let i=-35;i<=35;i+=14)line(`M${i}-64L${i+9}-44`,'#DACBA9',1.4);line('M-28-12L-40 5M29-12L40 5',C.ink,4);for(const xx of [-23,10]){box(xx,-60,21,7,3,'#D79E6D',C.ink,1.2)}steam(0,-66,.7)})}
function place(id,x,y,s,options){const setting=['tent','bell','dome','tarp','camper','cabin'].includes(id);if(setting){pine(x+110*s,y-20*s,.7*s,'#A9C294');grass(x-110*s,y,.7*s)}switch(id){case'tent':tent(x,y,s);break;case'bell':bell(x,y,s);break;case'dome':dome(x,y,s);break;case'tarp':tarp(x,y,s);break;case'camper':camper(x,y,s);break;case'cabin':cabin(x,y,s);break;case'home':home(x,y,s);break;default:market(x,y,s,id)}if(setting&&id!=='cabin'){bear(x+151*s,y+6*s,.62*s,C.yellow,'wave',true);flame(x+192*s,y+7*s,.4*s)}}

function taskScene(id,x,y,s=1){local(x,y,s,0,()=>{
 if(id==='gear-pickup'||id==='gear-return'){
  pack(-19,0);bear(79,0,.78,C.teal,id==='gear-return'?'sit':'wave',true);
  line(id==='gear-return'?'M32-96H-31l12-10M-31-96l12 10':'M-31-96H32l-12-10M32-96l-12 10',C.teal,3);
 }else if(id==='passenger-pickup'||id==='passenger-dropoff'){
  home(-54,0,.7);bear(12,0,.85,C.yellow,'wave',true);bear(70,0,.82,C.teal,'wave');
  line('M-94 16H109','#B4BDA1',2);
 }else if(id==='car-rental'||id==='car-return'){
  van(2,-4,1.3,C.blue);oval(48,-99,12,12,null,C.teal,4);line('M38-91l-22 23m4-4l-6-6m12 0l-6-6',C.teal,4);
  line(id==='car-return'?'M-75-95h35l-10-9M-40-95l-10 9':'M-40-95h-35l10-9M-75-95l10 9',C.teal,3);
 }else{bear(0,0,1,C.yellow,'wave');grass(-65,0);grass(65,0)}
})}

function scenery(id,x,y,s,tpl){local(x,y,s,0,()=>{
 if(id==='header-scene'){
  shape('M1040 204Q1100 125 1170 191Q1209 107 1274 175Q1320 119 1377 178Q1433 107 1518 169L1590 239Z','#E1E6CC',null);cloud(1190,84,.8);sun(1460,100);line('M1076 55q10-12 19 0q10-12 20 0M1135 34q7-9 14 0q7-9 14 0','#7F8872',2);
 }else if(id==='camp-scene'){
  c.translate(-1222,-458);shape('M953 437Q1000 349 1113 388Q1191 312 1322 365Q1456 306 1548 427L1558 497Q1240 531 952 484Z','#DCE6CF',null);
  pine(1494,439,.94,'#90AE82');pine(1440,438,.6,'#B4C99A');tree(1067,431,.57);
  const shapes={tent,bell,dome,tarp,camper,cabin,home};(shapes[tpl]||tent)(1222,458,1.05);
  bear(1355,478,.79,C.yellow,'wave',true);flame(1399,475,.55);grass(1140,493,.8);grass(1467,492,.8);bunting(1107,325,285);
 }else if(id==='photo-noodles'){
  bear(-59,0,.88,C.blue,'camera');noodles(54,-10,.73);sparkle(-108,-106,.6,C.teal);grass(166,-6,.65);
 }else if(id==='table-scene'){
  oval(-6,-1,154,13,'#E4DBBA',null);bear(-107,-9,.77,C.red,'sit');bear(104,-9,.8,C.teal,'wave',true);box(-77,-30,139,12,4,'#BD9868');line('M-62-17l-7 26M48-17l7 26','#967650',5);pot(-4,-26,.72);local(135,-44,.58,.18,()=>{box(-13,-25,28,37,4,'#FFF8E8');shape('M0-18L7-7 0 3-7-7Z',C.red,null)});grass(180,0,.8);
 }else if(id==='night-scene'){
  moon(-5,-80);for(let i=0;i<7;i++){c.save();c.globalAlpha=.5+.5*wave(2,i);sparkle(-96+(i*43%190),-109+(i*31%99),.4+(i%2)*.15,C.yellow);c.restore()}cup(-55,-5,.66);pine(91,0,.64,'#92AAA0');grass(113,1,.7);
 }else if(id==='breakfast-scene'){
  breakfast(-21,-24);grass(133,6,.8);
 }else if(id==='cleanup-scene'){
  bear(-4,0,.85,C.teal,'broom',true);grocery(56,-9,.5);
 }else if(id==='return-breakfast'){
  cup(114,0,.68);local(-41,1,.78,0,()=>{oval(0,0,92,17,'#E5D8B5',null);for(let i=0;i<3;i++){box(-60+i*29,-27,25,21,4,'#F3E4BC');line(`M${-55+i*29}-22l15 6`,'#D0B785',1.5)}shape('M35-8q-8-15 6-18q16-9 26 6q13 12-7 14Z','#FFF8E7',C.ink,1.5);oval(52,-17,7,5,C.yellow,null)});
 }
})}
function draw(ctx,id,x,y,s=1,t=0,options={}){const previous=c;c=ctx;time=((t%DURATION)+DURATION)%DURATION;phase=time/DURATION;labels=[];c.save();c.lineCap='round';c.lineJoin='round';try{switch(id){case'route-place':{const fn={home,tent,bell,dome,tarp,camper,cabin}[options.templateId];if(fn)fn(x,y,s);else market(x,y,s,options.templateId);break}case'header-scene':case'camp-scene':case'photo-noodles':case'table-scene':case'night-scene':case'breakfast-scene':case'cleanup-scene':case'return-breakfast':scenery(id,x,y,s,options.templateId);break;case'sun':sun(x,y);break;case'cloud':cloud(x,y,s);break;case'pine':pine(x,y,s);break;case'grass':grass(x,y,s);break;case'car':van(x,y,s,options.color||C.teal,false,options.alpha??1);break;case'breakfast':local(x,y,s,0,()=>breakfast(0,0));break;case'noodles':noodles(x,y,s);break;case'hotpot':pot(x,y,s);break;case'bbq':grill(x,y,s);break;case'explore':bear(x,y,s,C.blue,'camera');break;case'cleanup':bear(x,y,s,C.teal,'broom',true);break;case'pack':local(x,y,s,0,()=>pack(0,0));break;case'night':local(x,y-40*s,s,0,()=>{moon(0,0);sparkle(-64,10,.7);sparkle(63,-33,.55)});break;case'sunrise':local(x,y-54*s,s*.68,0,()=>sun(0,0));break;case'games':bear(x-35*s,y,s*.78,C.red,'sit');bear(x+39*s,y,s*.8,C.teal,'wave',true);break;case'setup':tent(x,y,s*.74);break;case'depart':van(x,y-15*s,s,C.blue);break;case'activity':bear(x,y,s,C.yellow,'wave');break;case'grocery':grocery(x,y,s);break;case'gear-pickup':case'gear-return':case'passenger-pickup':case'passenger-dropoff':case'car-rental':case'car-return':case'waypoint':taskScene(id,x,y,s);break;default:place(id,x,y,s,options)}}finally{c.restore();c=previous}}
export const StoryArt=Object.freeze({VERSION:'storybook-art-5',colors:C,draw});
