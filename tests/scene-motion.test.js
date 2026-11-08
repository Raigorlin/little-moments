import {describe,test,expect,beforeEach,afterEach} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {illustration} from '../src/art.js';
import {animatedIllustration,sceneMotionSettings,setupSceneMotion,syncSceneMotion,setSceneMotionPaused,sceneMotionState,teardownSceneMotion,SCENE_MOTION_KEY} from '../src/scene-motion.js';
import {STORAGE_KEY,THEMES_KEY} from '../src/model.js';

function fakeStorage(init={}){const data={...init};return{data,getItem:k=>k in data?data[k]:null,setItem:(k,v)=>{data[k]=String(v);}};}
function fakeQuery(matches=false){const listeners=new Set();return{matches,addEventListener:(t,f)=>listeners.add(f),removeEventListener:(t,f)=>listeners.delete(f),set(v){this.matches=v;listeners.forEach(f=>f());},listeners};}
function fakeButton(){const attrs={};return{hidden:false,attrs,setAttribute:(k,v)=>{attrs[k]=v;},closest(){return this;}};}
function fakeDoc(){const listeners={};const buttons=[];const notes=[];return{buttons,notes,listeners,documentElement:{dataset:{}},defaultView:null,addEventListener:(t,f)=>{(listeners[t]??=[]).push(f);},removeEventListener:(t,f)=>{listeners[t]=(listeners[t]||[]).filter(x=>x!==f);},querySelectorAll:sel=>sel==='[data-motion-reduced-note]'?notes:sel==='[data-scene-motion-toggle]'?buttons:[],click(target){const ev={target,prevented:false,preventDefault(){this.prevented=true;}};(listeners.click||[]).forEach(f=>f(ev));return ev;}};}
const fakeWin=()=>({addEventListener(){},removeEventListener(){}});

afterEach(()=>teardownSceneMotion());

describe('art layers',()=>{
  test('camp keeps original transforms and adds layer wrappers',()=>{
    const svg=illustration('camp');
    expect(svg).toContain('<g class="scene-layer scene-cloud"><path transform="translate(80 50) scale(1)"');
    expect(svg).toContain('<g transform="translate(40 184) scale(0.98)"');
    expect(svg.match(/scene-tree/g).length).toBe(4);
    expect(svg.match(/scene-cloud/g).length).toBe(2);
    expect(svg).toContain('scene-sun');
    expect(svg).toContain('scene-flame');
    expect(svg).not.toMatch(/class="scene-layer[^"]*"[^>]*transform=/);
  });
  test('other kinds still render and unknown kind falls back to camp',()=>{
    for(const k of ['travel','meal','market','night'])expect(illustration(k)).toContain(`illustration--${k}`);
    expect(illustration('nope')).toContain('illustration--camp');
    expect(illustration('night')).toContain('class="scene-layer scene-cloud"');
    expect(illustration('night')).toContain('class="scene-layer scene-sun"');
    expect(illustration('travel','',{preserveAspectRatio:'xMidYMid slice'})).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(illustration('travel','',{preserveAspectRatio:'invalid'})).toContain('preserveAspectRatio="xMidYMid meet"');
    const travelWithoutSun=illustration('travel','',{hideSun:true});
    expect(travelWithoutSun).not.toContain('class="scene-layer scene-sun"');
    expect(travelWithoutSun).toContain('class="scene-layer scene-cloud"');
    expect(illustration('travel')).toContain('class="scene-layer scene-sun"');
  });
});

describe('animatedIllustration',()=>{
  test('wraps only the original svg, with no controls and no external resources',()=>{
    for(const kind of ['camp','travel','meal','market','night'])expect(animatedIllustration(kind)).toBe(`<div class="scene-motion illustration scene-motion--${kind}">${illustration(kind)}</div>`);
    const html=animatedIllustration();
    expect(html.startsWith('<div class="scene-motion illustration scene-motion--camp">')).toBe(true);
    expect(html).toContain('illustration--camp');
    expect(html).not.toMatch(/<button|data-scene-motion-toggle|scene-motion__toggle|data-motion-reduced-note/);
    expect(html.replaceAll('xmlns="http://www.w3.org/2000/svg"','')).not.toMatch(/https?:|<img|<image|url\(/);
    expect(html).not.toContain('data-action');
  });
  test('sanitizes kind in class',()=>{expect(animatedIllustration('"><x')).toContain('scene-motion--x"');});
  test('supports full-frame artwork without cropping or a baked-in background',()=>{
    const art=animatedIllustration('night',{preserveAspectRatio:'xMidYMax meet',transparentBackground:true,fullFrame:true});
    expect(art).toContain('preserveAspectRatio="xMidYMax meet"');
    expect(art).toContain('style="display:block;width:100%;height:100%;max-width:none"');
    expect(art).not.toContain('<rect x="0" y="0" width="680" height="300"');
    const travelArt=animatedIllustration('travel',{hideSun:true});
    expect(travelArt).not.toContain('class="scene-layer scene-sun"');
    expect(travelArt).toContain('class="scene-layer scene-cloud"');
  });
  test('stays control-free whatever the motion state',()=>{
    setupSceneMotion({document:fakeDoc(),window:fakeWin(),storage:fakeStorage({[SCENE_MOTION_KEY]:'paused'}),reducedMotion:fakeQuery(true)});
    expect(animatedIllustration()).toBe(`<div class="scene-motion illustration scene-motion--camp">${illustration('camp')}</div>`);
  });
});

describe('sceneMotionSettings',()=>{
  test('renders a small section with heading, copy and a native toggle',()=>{
    const html=sceneMotionSettings();
    expect(html.startsWith('<section class="motion-settings"')).toBe(true);
    expect(html.endsWith('</section>')).toBe(true);
    expect(html).toContain('<h3>插畫動畫</h3>');
    expect(html).toContain('<p>控制車子與背景動態，只影響這台裝置。</p>');
    expect(html).toContain('<button type="button" class="scene-motion__toggle" data-scene-motion-toggle aria-label="暫停動畫">');
    expect(html).not.toContain('aria-pressed');
    expect(html).toContain('scene-motion__icon--pause');
    expect(html).toContain('scene-motion__icon--play');
    expect(html).toContain('<span class="scene-motion__label scene-motion__label--pause">暫停動畫</span><span class="scene-motion__label scene-motion__label--play">播放動畫</span>');
    expect(html).toContain('data-motion-reduced-note hidden>依系統減少動態設定，插畫保持靜態。</p>');
    expect(html).not.toMatch(/<svg[^>]*class="illustration|scene-layer|data-action|\bid=|https?:|url\(/);
    expect(html.match(/<button/g).length).toBe(1);
  });
  test('reflects paused preference at render time',()=>{
    setupSceneMotion({document:fakeDoc(),window:fakeWin(),storage:fakeStorage({[SCENE_MOTION_KEY]:'paused'}),reducedMotion:fakeQuery(false)});
    const html=sceneMotionSettings();
    expect(html).toContain('aria-label="播放動畫">');
    expect(html).toContain('data-motion-reduced-note hidden>');
  });
  test('reduced motion hides the toggle and shows the note at render time',()=>{
    setupSceneMotion({document:fakeDoc(),window:fakeWin(),storage:fakeStorage(),reducedMotion:fakeQuery(true)});
    const html=sceneMotionSettings();
    expect(html).toContain('aria-label="暫停動畫" hidden>');
    expect(html).toContain('data-motion-reduced-note>依系統減少動態設定');
  });
});

describe('setupSceneMotion',()=>{
  let doc,storage,query;
  beforeEach(()=>{doc=fakeDoc();storage=fakeStorage({[STORAGE_KEY]:'{"trip":1}'});query=fakeQuery(false);});
  const setup=()=>setupSceneMotion({document:doc,window:fakeWin(),storage,reducedMotion:query});

  test('static before setup',()=>{expect(sceneMotionState()).toBe('static');expect(syncSceneMotion()).toBe('static');});
  test('sets root attribute, idempotent listener',()=>{
    expect(setup()).toBe('running');expect(setup()).toBe('running');
    expect(doc.listeners.click.length).toBe(1);
    expect(query.listeners.size).toBe(1);
    expect(doc.documentElement.dataset.sceneMotion).toBe('running');
  });
  test('toggle persists separate preference and never touches travel data',()=>{
    setup();const b=fakeButton();doc.buttons.push(b);
    const ev=doc.click(b);expect(ev.prevented).toBe(true);
    expect(doc.documentElement.dataset.sceneMotion).toBe('paused');
    expect(storage.data[SCENE_MOTION_KEY]).toBe('paused');
    expect(b.attrs['aria-label']).toBe('播放動畫');
    expect(storage.data[STORAGE_KEY]).toBe('{"trip":1}');
    expect(THEMES_KEY in storage.data).toBe(false);
    doc.click(b);expect(storage.data[SCENE_MOTION_KEY]).toBe('playing');expect(b.attrs['aria-label']).toBe('暫停動畫');expect('aria-pressed' in b.attrs).toBe(false);
  });
  test('clicks on the icon inside a toggle nested in <details> still toggle every control',()=>{
    setup();const inDetails=fakeButton(),footer=fakeButton();doc.buttons.push(inDetails,footer);
    const icon={closest:sel=>sel==='[data-scene-motion-toggle]'?inDetails:null};
    const ev=doc.click(icon);expect(ev.prevented).toBe(true);
    expect(storage.data[SCENE_MOTION_KEY]).toBe('paused');
    for(const b of [inDetails,footer]){expect(b.attrs['aria-label']).toBe('播放動畫');expect(b.hidden).toBe(false);}
  });
  test('restores pause and rerendered markup reflects it; sync updates new buttons',()=>{
    storage.setItem(SCENE_MOTION_KEY,'paused');setup();
    expect(sceneMotionSettings()).toContain('aria-label="播放動畫">');
    const b=fakeButton();doc.buttons.push(b);syncSceneMotion();expect(b.attrs['aria-label']).toBe('播放動畫');
  });
  test('ignores clicks elsewhere',()=>{setup();const ev=doc.click({closest:()=>null});expect(ev.prevented).toBe(false);expect(storage.data[SCENE_MOTION_KEY]).toBeUndefined();});
  test('reduced motion is static, hides buttons, ignores toggles, reacts to changes',()=>{
    query.matches=true;expect(setup()).toBe('reduced');
    expect(sceneMotionSettings()).toContain('aria-label="暫停動畫" hidden>');
    const b=fakeButton(),note={hidden:true};doc.buttons.push(b);doc.notes.push(note);syncSceneMotion();expect(b.hidden).toBe(true);expect(note.hidden).toBe(false);
    doc.click(b);expect(storage.data[SCENE_MOTION_KEY]).toBeUndefined();
    query.set(false);expect(doc.documentElement.dataset.sceneMotion).toBe('running');expect(b.hidden).toBe(false);expect(note.hidden).toBe(true);
    storage.setItem(SCENE_MOTION_KEY,'paused');query.set(true);expect(b.hidden).toBe(true);expect(b.attrs['aria-label']).toBe('暫停動畫');
    query.set(false);expect(doc.documentElement.dataset.sceneMotion).toBe('paused');expect(b.attrs['aria-label']).toBe('播放動畫');
  });
  test('storage failures fall back to memory',()=>{
    storage={getItem(){throw new Error('x');},setItem(){throw new Error('x');}};setup();
    expect(setSceneMotionPaused(true)).toBe('paused');expect(syncSceneMotion()).toBe('paused');
  });
  test('teardown removes listeners and attribute',()=>{setup();teardownSceneMotion();expect(doc.listeners.click.length).toBe(0);expect(doc.documentElement.dataset.sceneMotion).toBeUndefined();});
});

const ORIGINAL_SHA={
  camp:'55defb054d978639a9b8429ea08f6ff6eea8fd3805cae8263419e6ed717d86ce',
  travel:'b7013454ed263e7bff4875f253590c3913d1c1d1ccd796143e4c87c123b625bf',
  meal:'cc9f15e191042c3cbcb92d19925dadfdde8df2b6cecb0320d15ddf6f014e3015',
  market:'65ba26c211bc1341e41741199886c80046de37df4880ec6671bb81e184e1f664',
  night:'4cc98a91fc4da32cc69158b953d77739356806899d37f9ce288c4cdea9c56f78',
};
const VAN_OPEN='<g class="scene-layer scene-van">';
const BOUNCE_OPEN='<g class="scene-layer scene-van-bounce">';
const NIGHT_CLOUD_OPEN='<g class="scene-layer scene-cloud" stroke=';
const NIGHT_SUN_OPEN='<g class="scene-layer scene-sun">';
const sha=s=>createHash('sha256').update(s).digest('hex');
function unwrap(markup,open){
  let out=markup;
  for(let start=out.indexOf(open);start!==-1;start=out.indexOf(open)){
    const tags=/<g[\s>]|<\/g>/g;tags.lastIndex=start+open.length;let depth=1,m;
    while(depth&&(m=tags.exec(out)))depth+=m[0]==='</g>'?-1:1;
    if(depth)throw new Error('unbalanced wrapper');
    out=out.slice(0,start)+out.slice(start+open.length,m.index)+out.slice(m.index+4);
  }
  return out;
}
const stripVanWrappers=s=>unwrap(unwrap(s,BOUNCE_OPEN),VAN_OPEN);
const stripMotionWrappers=(s,kind)=>{
  let out=stripVanWrappers(s);
  if(kind==='night')out=unwrap(out.replace(NIGHT_CLOUD_OPEN,'<g stroke='),NIGHT_SUN_OPEN);
  return out;
};
const primitives=s=>s.match(/<(svg|path|circle|rect|line)\b[^>]*>/g);

describe('van motion layers',()=>{
  test('removing motion-only wrappers restores byte-identical original art',()=>{
    for(const [kind,hash] of Object.entries(ORIGINAL_SHA))expect(sha(stripMotionWrappers(illustration(kind),kind))).toBe(hash);
  });
  test('wrappers add no primitives and keep viewBox, coordinates and colours',()=>{
    for(const kind of ['camp','travel']){
      const svg=illustration(kind);
      expect(primitives(svg)).toEqual(primitives(stripVanWrappers(svg)));
      expect(svg.split(VAN_OPEN+BOUNCE_OPEN).length).toBe(2);
    }
    const camp=illustration('camp');
    expect(camp).toContain('viewBox="0 0 680 340"');
    expect(camp).toContain(VAN_OPEN+BOUNCE_OPEN+'<g transform="translate(40 184) scale(0.98)"');
    expect(illustration('travel')).toContain(VAN_OPEN+BOUNCE_OPEN+'<g transform="translate(240 108) scale(1)"');
    const van=camp.slice(camp.indexOf(VAN_OPEN));
    expect(van).toContain('fill="#f6d27a"');
    expect(van.match(/<circle cx="(50|158)" cy="90" r="16"/g).length).toBe(2);
  });
  test('wrappers carry only classes, never transforms or paint',()=>{
    const wrappers=illustration('camp').match(/<g class="scene-layer[^>]*>/g);
    for(const w of wrappers)expect(w).toMatch(/^<g class="scene-layer [a-z-]+">$/);
  });
  test('only the animated hero gets the van layers inside .scene-motion; thumbnails stay plain',()=>{
    const thumb=illustration('camp');
    expect(thumb).not.toContain('scene-motion');
    expect(animatedIllustration('camp')).toContain(VAN_OPEN+BOUNCE_OPEN);
    expect(animatedIllustration('camp').startsWith('<div class="scene-motion ')).toBe(true);
  });
});

describe('scene-motion.css',()=>{
  const css=readFileSync(new URL('../src/scene-motion.css',import.meta.url),'utf8');
  test('animations only under no-preference and running/paused root',()=>{
    const outside=css.replace(/@media \(prefers-reduced-motion:no-preference\)\{[\s\S]*?\n\}/,'');
    expect(outside).not.toMatch(/animation:scene-/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*animation:none!important/);
    expect(css).toMatch(/@media print\{[^\n]*animation:none!important/);
  });
  test('only transform/opacity are animated, no external urls',()=>{
    for(const kf of css.match(/@keyframes[^\n]+/g)){const props=[...kf.matchAll(/([a-z-]+):/g)].map(m=>m[1]);for(const p of props)expect(['transform','opacity']).toContain(p);}
    expect(css).not.toMatch(/url\(|@import/);
  });
  test('toggle lives in the settings flow, never over the art, and is hidden for reduced/print',()=>{
    const toggle=css.match(/^\.scene-motion__toggle\{[^}]*\}/m)[0];
    expect(toggle).not.toMatch(/position:(absolute|fixed)|z-index|left:|top:/);
    expect(css).not.toMatch(/\.scene-motion \.scene-motion__toggle|\.scene-motion>\.scene-motion__toggle/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^\n]*\.scene-motion__toggle\{display:none!important\}[^\n]*\.motion-settings__note\{display:block!important\}/);
    expect(css).toMatch(/@media print\{[^\n]*\.scene-motion__toggle,\.motion-settings\{display:none!important\}/);
    expect(css).toContain('.scene-motion__toggle[hidden]{display:none!important}');
    expect(css).toContain('.motion-settings__note[hidden]{display:none}');
  });
  test('van drive and bounce are restrained, scoped and covered by pause/reduced/print',()=>{
    const motion=css.match(/@media \(prefers-reduced-motion:no-preference\)\{([\s\S]*?)\n\}/)[1];
    const vanRules=motion.split('\n').filter(l=>/scene-van/.test(l));
    expect(vanRules.length).toBe(2);
    for(const rule of vanRules){
      const selectors=rule.slice(0,rule.indexOf('{')).split(',');
      expect(selectors.map(x=>x.trim().replace(/ \.scene-van(-bounce)?$/,''))).toEqual([':root[data-scene-motion=running] .scene-motion',':root[data-scene-motion=paused] .scene-motion']);
    }
    expect(motion).toContain('animation:scene-van-drive ');
    expect(motion).toContain('animation:scene-van-bounce ');
    expect(motion).toContain(':root[data-scene-motion=paused] .scene-motion .scene-layer{animation-play-state:paused}');
    expect(css).toContain('@keyframes scene-van-drive{from{transform:translateX(0)}to{transform:translateX(14px)}}');
    expect(css).toContain('@keyframes scene-van-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}');
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.scene-motion \.scene-layer\{animation:none!important\}/);
    expect(css).toMatch(/@media print\{\.scene-motion \.scene-layer\{animation:none!important;transform:none!important\}/);
    expect(css.replace(motion,'')).not.toMatch(/\.scene-van[^-]|\.scene-van-bounce/);
  });
});
