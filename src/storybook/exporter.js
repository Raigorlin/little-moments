// PNG/GIF export (storybook-export-1), module form of demos/storybook-trip-studio/exporter.js.
// gifenc is loaded on demand as a same-origin bundled chunk; nothing runs in a blob worker.
import * as ModelModule from './model.js';
import { StudioRenderer } from './renderer.js';
import { StoryArt } from './artwork.js';

const StudioModel=ModelModule.StudioModel||ModelModule.default||ModelModule;
const DURATION=16,FPS=25,MAX_BYTES=40*1024*1024,MAX_PIXELS=7_000_000;
let cached=null,gifLib=null;
const loadGif=()=>gifLib||(gifLib=import('../../assets/storybook/vendor/gifenc.js').catch(e=>{gifLib=null;throw e}));
const yieldUI=()=>new Promise(resolve=>{const ch=new MessageChannel();ch.port1.onmessage=()=>{ch.port1.close();ch.port2.close();resolve()};ch.port2.postMessage(0)});
function aborted(signal){if(signal?.aborted)throw new DOMException('已取消產生','AbortError')}
async function fonts(plan){if(!document.fonts)return;const text=JSON.stringify(plan??'');await Promise.all([document.fonts.load('24px "jf open 粉圓"',text),document.fonts.load('24px "Patrick Hand"')]);await document.fonts.ready}
function settings(plan,l=StudioRenderer.layout(plan)){const width=1280,height=Math.ceil(l.height*width/l.width),allowed=height<=8192&&width*height<=MAX_PIXELS;return{width,height,frames:DURATION*FPS,duration:DURATION,allowed,reason:allowed?'':'行程海報過長，GIF 上限為 700 萬像素。PNG、文字版與 JSON 仍保留完整內容。'}}
function canvas(width,height){const ca=document.createElement('canvas');ca.width=width;ca.height=height;return ca}
function asBlob(c,type='image/png'){return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('無法建立圖片，請減少內容後重試。')),type))}
async function png(plan){await fonts(plan);const p=StudioModel.validate(plan),l=StudioRenderer.layout(p),scale=Math.min(1,Math.sqrt(12_000_000/(l.width*l.height)),16000/l.height),c=canvas(Math.max(1,Math.floor(l.width*scale)),Math.max(1,Math.floor(l.height*scale)));StudioRenderer.draw(c,p,l,6);return asBlob(c)}
async function generate(plan,{signal,onProgress=()=>{}}={}){const p=StudioModel.validate(plan);aborted(signal);await fonts(plan);aborted(signal);const GIFLib=await loadGif();aborted(signal);const l=StudioRenderer.layout(p),cfg=settings(p,l);if(!cfg.allowed)throw new Error(cfg.reason);const key=[await StudioModel.fingerprint(p),StudioRenderer.VERSION,StoryArt.VERSION,cfg.width,cfg.height,FPS,DURATION].join('|');aborted(signal);if(cached?.key===key){onProgress(100);return cached}onProgress(0);await yieldUI();aborted(signal);
const ca=canvas(cfg.width,cfg.height),ctx=ca.getContext('2d',{willReadFrequently:true}),sw=400,sh=Math.max(1,Math.round(l.height*sw/l.width)),sample=canvas(sw,sh),sx=sample.getContext('2d',{willReadFrequently:true}),chunks=[];
for(let i=0;i<8;i++){aborted(signal);StudioRenderer.draw(sample,p,l,i*2);chunks.push(sx.getImageData(0,0,sw,sh).data);onProgress(i/8*8);await yieldUI()}
const merged=new Uint8Array(chunks.length*sw*sh*4);chunks.forEach((a,i)=>merged.set(a,i*a.length));const palette=GIFLib.quantize(merged,255,{format:'rgb565'}),full=palette.map(v=>v.slice());while(full.length<256)full.push([0,0,0]);const gif=GIFLib.GIFEncoder();let previous=null;await yieldUI();aborted(signal);
for(let i=0;i<cfg.frames;i++){aborted(signal);StudioRenderer.draw(ca,p,l,i/FPS);const indexed=GIFLib.applyPalette(ctx.getImageData(0,0,cfg.width,cfg.height).data,palette,'rgb565');if(previous){const diff=indexed.slice();for(let j=0;j<diff.length;j++)if(diff[j]===previous[j])diff[j]=255;gif.writeFrame(diff,cfg.width,cfg.height,{delay:40,transparent:true,transparentIndex:255,dispose:1})}else gif.writeFrame(indexed,cfg.width,cfg.height,{palette:full,repeat:0,delay:40,dispose:1});previous=indexed;if(gif.bytesView().byteLength>MAX_BYTES)throw new Error('GIF 超過 40 MB，請減少天數或內容後重試。');onProgress(8+(i+1)/cfg.frames*90);await yieldUI()}
aborted(signal);gif.finish();const blob=new Blob([gif.bytes()],{type:'image/gif'});StudioRenderer.draw(ca,p,l,6);const poster=await asBlob(ca);aborted(signal);cached={blob,poster,width:cfg.width,height:cfg.height,frames:cfg.frames,duration:DURATION,key};onProgress(100);return cached}
// Drops the module-level GIF cache so a destroyed studio does not keep the last trip's blobs alive.
function clearCache(){cached=null}
export const StudioExport=Object.freeze({VERSION:'storybook-export-1',generate,png,settings,clearCache});
