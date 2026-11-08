import {test,expect} from 'bun:test';
import {resolveAxis,trackOffset,sampleVelocity,releaseVelocity,resolveRelease,shouldSuppressClick,createFrameWriter} from '../src/mobile-swipe.js';

// ---------------------------------------------------------------------------
// Deterministic property-test harness.
//
// The repository carries no property-based testing dependency and this feature
// introduces none, so the generator lives here. Contract for the property
// tests that build on it:
//
//   forAll(name, generator, property, options?)
//     registers a bun test that runs `generator` at least ITERATIONS times.
//     `generator(gen, i)` receives the per-iteration random source and the
//     iteration index, and returns the sample. `property(sample, gen)` either
//     asserts with `expect` or returns false to fail. On failure the thrown
//     message carries the seed and the JSON-serialized sample, so a human can
//     replay the exact counterexample with SWIPE_SEED=<seed>.
//
//   runAll(...) is the same runner without the test registration, for the
//     harness self-checks below.
//
// Each iteration draws from its own PRNG seeded from (stream seed + index), so
// one iteration is replayable in isolation and adding iterations or new
// properties never shifts the samples of the existing ones.
// ---------------------------------------------------------------------------

/** Base seed. Override to replay a reported counterexample: SWIPE_SEED=12345 bun test */
export const SEED=(Number(process.env.SWIPE_SEED)||0x5EED1E)>>>0;
/** Iterations per property. At least 200, per the testing strategy in design.md. */
export const ITERATIONS=Math.max(200,Number(process.env.SWIPE_ITERATIONS)||200);
/** Largest magnitude still strictly inside the 8px axis dead zone. */
const AXIS_DEADZONE_EXCLUSIVE=7.999;

/** Standard mulberry32: 32-bit seed in, float in [0,1) out. */
export function mulberry32(seed){
 let a=seed>>>0;
 return function(){
  a=(a+0x6D2B79F5)>>>0;
  let t=a;
  t=Math.imul(t^(t>>>15),t|1);
  t^=t+Math.imul(t^(t>>>7),t|61);
  return ((t^(t>>>14))>>>0)/4294967296;
 };
}

/** FNV-1a over the property name, so each property owns an independent stream. */
function streamSeed(name,base){
 let h=0x811C9DC5;
 for(let i=0;i<name.length;i+=1){h=Math.imul(h^name.charCodeAt(i),0x01000193);}
 return (h^base)>>>0;
}

/** Convenience draws over a PRNG. Shared by every property generator. */
export function sampler(random){
 return {
  random,
  float(min,max){return min+random()*(max-min);},
  int(min,max){return Math.floor(min+random()*(max-min+1));},
  pick(list){return list[Math.floor(random()*list.length)];},
  bool(probability=0.5){return random()<probability;},
  sign(){return random()<0.5?-1:1;}
 };
}

/** JSON for the failure message, surviving NaN, Infinity and undefined. */
export function describeSample(sample){
 const json=JSON.stringify(sample,(_key,value)=>{
  if(typeof value==='number'&&!Number.isFinite(value))return String(value);
  if(value===undefined)return '<undefined>';
  return value;
 });
 return json===undefined?String(sample):json;
}

/** The runner. Throws a reproducible counterexample report on the first failure. */
export function runAll(name,generator,property,options={}){
 const base=(options.seed??SEED)>>>0;
 const iterations=Math.max(200,options.iterations??ITERATIONS);
 const stream=streamSeed(name,base);
 for(let i=0;i<iterations;i+=1){
  const iterationSeed=(stream+i*0x9E3779B1)>>>0;
  const gen=sampler(mulberry32(iterationSeed));
  let sample;
  try{sample=generator(gen,i);}
  catch(error){throw new Error(report(name,i,iterations,base,iterationSeed,'<generator threw>',error.message));}
  try{
   if(property(sample,gen)===false)throw new Error('property returned false');
  }catch(error){
   throw new Error(report(name,i,iterations,base,iterationSeed,describeSample(sample),error.message));
  }
 }
}

function report(name,i,iterations,base,iterationSeed,sampleJson,message){
 return `${name}\n  failed on iteration ${i+1} of ${iterations}\n  seed: ${base} (replay this run with SWIPE_SEED=${base}; iteration seed ${iterationSeed})\n  sample: ${sampleJson}\n  cause: ${message}`;
}

/** Register a property as a bun test. The entry point for tasks 2.2 onward. */
export function forAll(name,generator,property,options={}){
 test(name,()=>runAll(name,generator,property,options));
}

// ---------------------------------------------------------------------------
// Harness self-checks and smoke coverage of already-verified facts.
// ---------------------------------------------------------------------------

test('the pure layer imports without a DOM and agrees with its documented examples',()=>{
 expect(resolveAxis(10,8)).toBe('horizontal');   // horizontal wins the 10 vs 8 bias
 expect(resolveAxis(8,10)).toBeNull();           // vertical needs ay > ax*1.25, so 10 vs 8 ties and declines
 expect(trackOffset(0,-50,-136)).toBe(-50);      // linear zone tracks the finger 1:1
 expect(sampleVelocity([])).toBeNull();          // no samples means not measured, not stationary
 expect(typeof resolveRelease).toBe('function');
 expect(typeof shouldSuppressClick).toBe('function');
});

test('mulberry32 is seeded, in range, and reproducible',()=>{
 const first=mulberry32(1),second=mulberry32(1),other=mulberry32(2);
 const drawn=[];
 for(let i=0;i<64;i+=1){
  const value=first();
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThan(1);
  expect(second()).toBe(value);
  drawn.push(value);
 }
 expect(drawn.some(value=>value!==other())).toBe(true);
 expect(new Set(drawn).size).toBeGreaterThan(32);
});

test('runAll drives at least 200 iterations from the seeded generator',()=>{
 const seen=[];
 runAll('harness iteration count',gen=>gen.float(-200,200),sample=>{seen.push(sample);return Number.isFinite(sample);});
 expect(seen.length).toBeGreaterThanOrEqual(200);
 expect(new Set(seen).size).toBe(seen.length);
 const replay=[];
 runAll('harness iteration count',gen=>gen.float(-200,200),sample=>{replay.push(sample);});
 expect(replay).toEqual(seen);
});

test('a failing property reports the seed and the JSON sample so it can be replayed',()=>{
 const run=()=>runAll('harness failure report',gen=>({dx:gen.int(1,1),label:'x'}),()=>false,{seed:99});
 expect(run).toThrow(/seed: 99/);
 expect(run).toThrow(/SWIPE_SEED=99/);
 expect(run).toThrow(/\{"dx":1,"label":"x"\}/);
 expect(run).toThrow(/property returned false/);
 expect(()=>runAll('harness assertion report',gen=>gen.int(3,3),sample=>{expect(sample).toBe(4);},{seed:7}))
  .toThrow(/sample: 3/);
});

forAll('harness: the generator path reaches the pure layer',
 gen=>{
  const magnitude=gen.float(0,AXIS_DEADZONE_EXCLUSIVE);
  return {dx:gen.sign()*magnitude,dy:gen.sign()*gen.float(0,AXIS_DEADZONE_EXCLUSIVE)};
 },
 ({dx,dy})=>{
  // Both displacements sit inside the 8px dead zone, so no axis can resolve.
  expect(resolveAxis(dx,dy)).toBeNull();
 });
// ---------------------------------------------------------------------------
// Property 4: The axis lock is exclusive, dead-zoned, and sticky
// **Validates: Requirements 4.1, 4.2**
//
// The contract restated from the requirements: horizontal resolves when the
// horizontal magnitude reaches 8 and is at least 1.25x the vertical magnitude
// (4.1); vertical resolves when the vertical magnitude reaches 8 and strictly
// exceeds 1.25x the horizontal magnitude (4.2). The strict `>` on the vertical
// side is what hands an exact tie to horizontal, so a wedge of near-diagonal
// input resolves to neither axis and correctly stays unresolved. These tests
// encode that real contract, not an idealized "everything outside the dead
// zone resolves to something".
// ---------------------------------------------------------------------------

/** The requirement 4.1 / 4.2 thresholds, named here so the test states the contract itself. */
const AXIS_DEADZONE_PX=8,AXIS_BIAS_RATIO=1.25;
const AXIS_LOCKS=['horizontal','vertical'];
/** Every value resolveAxis is permitted to return. A fourth outcome must fail the property. */
const AXIS_OUTCOMES=new Set([...AXIS_LOCKS,null]);

/** Magnitudes that resolve to `axis`: past the dead zone and on the winning side of the bias. */
function resolvingPair(gen,axis){
 if(axis==='horizontal'){const ax=gen.float(AXIS_DEADZONE_PX,400);return {ax,ay:gen.float(0,ax/AXIS_BIAS_RATIO)};}
 const ay=gen.float(AXIS_DEADZONE_PX,400);
 return {ax:gen.float(0,ay/AXIS_BIAS_RATIO),ay};
}

/** The near-diagonal wedge: both magnitudes clear the dead zone, yet neither axis wins. */
function wedgePair(gen){
 const ax=gen.float(11,400);
 return gen.bool(0.25)?{ax,ay:ax*AXIS_BIAS_RATIO}:{ax,ay:ax*gen.float(0.81,AXIS_BIAS_RATIO)};
}

/** Magnitude pairs spanning zero, the dead zone, both resolving regions, the wedge and the boundaries. */
function axisPair(gen){
 const kind=gen.pick(['zero','deadzone','horizontal','vertical','wedge','wide','boundary']);
 if(kind==='zero')return {kind,ax:0,ay:0};
 if(kind==='deadzone')return {kind,ax:gen.float(0,AXIS_DEADZONE_PX),ay:gen.float(0,AXIS_DEADZONE_PX)};
 if(kind==='horizontal'||kind==='vertical')return {kind,...resolvingPair(gen,kind)};
 if(kind==='wedge')return {kind,...wedgePair(gen)};
 if(kind==='wide')return {kind,ax:gen.float(0,4000),ay:gen.float(0,4000)};
 return {kind,ax:gen.pick([0,1,7.5,AXIS_DEADZONE_EXCLUSIVE,AXIS_DEADZONE_PX,8.0001,10,42,136]),ay:gen.pick([0,1,7.5,AXIS_DEADZONE_EXCLUSIVE,AXIS_DEADZONE_PX,10,12.5,136])};
}

/** A displacement pair carrying independent signs, since the axis rule reads magnitudes only. */
function axisSample(gen){
 const {kind,ax,ay}=axisPair(gen);
 return {kind,ax,ay,dx:gen.sign()*ax,dy:gen.sign()*ay};
}

forAll('property 4: resolveAxis returns exactly one of horizontal, vertical or unresolved',
 gen=>axisSample(gen),
 ({dx,dy,ax,ay})=>{
  const axis=resolveAxis(dx,dy);
  expect(AXIS_OUTCOMES.has(axis)).toBe(true);        // totality: never a fourth outcome
  expect(resolveAxis(dx,dy,null)).toBe(axis);        // null is the unresolved lock the default stands for
  const horizontal=ax>=AXIS_DEADZONE_PX&&ax>=ay*AXIS_BIAS_RATIO;  // requirement 4.1
  const vertical=ay>=AXIS_DEADZONE_PX&&ay>ax*AXIS_BIAS_RATIO;     // requirement 4.2
  expect(horizontal&&vertical).toBe(false);          // exclusivity: the two conditions cannot hold together
  expect(axis==='horizontal').toBe(horizontal);
  expect(axis==='vertical').toBe(vertical);
  expect(axis===null).toBe(!horizontal&&!vertical);  // the near-diagonal wedge resolves to neither axis
 });

forAll('property 4: resolveAxis leaves the axis unresolved while both displacements sit inside the 8px dead zone',
 gen=>{
  const magnitude=()=>gen.bool(0.25)?gen.pick([0,0.5,1,4,7,AXIS_DEADZONE_EXCLUSIVE]):gen.float(0,AXIS_DEADZONE_PX);
  return {dx:gen.sign()*magnitude(),dy:gen.sign()*magnitude()};
 },
 ({dx,dy})=>{
  expect(Math.abs(dx)).toBeLessThan(AXIS_DEADZONE_PX);  // the generator really stays inside the dead zone
  expect(Math.abs(dy)).toBeLessThan(AXIS_DEADZONE_PX);
  expect(resolveAxis(dx,dy)).toBeNull();
 });

forAll('property 4: an already-resolved axis lock sticks for any later displacement',
 gen=>{
  const locked=gen.pick(AXIS_LOCKS);
  const other=locked==='horizontal'?'vertical':'horizontal';
  const conflicting=gen.bool(0.5);
  const pair=conflicting?{kind:'resolves-'+other,...resolvingPair(gen,other)}:axisPair(gen);
  return {locked,other,conflicting,kind:pair.kind,dx:gen.sign()*pair.ax,dy:gen.sign()*pair.ay};
 },
 ({locked,other,conflicting,dx,dy})=>{
  // Half the samples would resolve to the opposite axis if the gesture were still undecided.
  if(conflicting)expect(resolveAxis(dx,dy)).toBe(other);
  expect(resolveAxis(dx,dy,locked)).toBe(locked);
 });
// ---------------------------------------------------------------------------
// Property 1: Tracking is one-to-one inside the linear zone
// **Validates: Requirements 1.2, 1.3**
//
// The contract: for any start offset, any pointer displacement and any
// End_Stop, if the sum of the start offset and the displacement falls between
// the End_Stop and zero *inclusive*, `trackOffset` returns exactly that sum.
// No scaling, no easing, no interpolation - the row is the finger.
//
// The generator lands inside the zone by construction rather than by chance:
// it picks a start offset, then draws the displacement from the window
// `[endStop - startOffset, -startOffset]` that maps the sum onto the zone.
// Floating point is handled by construction too. `-startOffset` is an exact
// negation, so the closed boundary is reachable from any start offset; the
// other endpoint is exact only when the start offset is itself `0` or the
// End_Stop, which are the only two resting values the tracker uses, so that is
// where the end-stop boundary is drawn. Elsewhere the draw keeps a margin off
// both endpoints, far wider than a rounding error. Every assertion compares
// against the recomputed sum `startOffset + dx`, which is what the contract
// says, never against the target the generator aimed at.
// ---------------------------------------------------------------------------

/** The real panel geometry: End_Stop is -(swipeCount * 68) for the row shapes in this app. */
const ACTION_WIDTH_PX=68,SWIPE_COUNTS=[1,2,3,4,5,6];

/** End_Stop candidates: the shipped geometry, plus arbitrary negatives since the property is general. */
function linearEndStop(gen){
 const kind=gen.pick(['geometry','geometry','geometry','arbitrary','tiny','huge']);
 if(kind==='geometry')return {kind,endStop:-(gen.pick(SWIPE_COUNTS)*ACTION_WIDTH_PX)};
 if(kind==='tiny')return {kind,endStop:-gen.float(0.001,1)};
 if(kind==='huge')return {kind,endStop:-gen.float(1000,100000)};
 return {kind,endStop:-gen.float(1,4000)};
}

/** A start offset: `0` closed or the End_Stop open, which is the tracker's rule, plus in-between for generality. */
function linearStart(gen,endStop){
 const rest=gen.pick(['closed','closed','open','open','between']);
 if(rest==='closed')return {rest,startOffset:0};
 if(rest==='open')return {rest,startOffset:endStop};
 return {rest,startOffset:endStop-gen.float(0.1,0.9)*endStop};
}

/** A displacement whose raw sum sits inside `[endStop,0]`, hitting both inclusive boundaries deliberately. */
function linearDx(gen,rest,startOffset,endStop,edge){
 const low=endStop-startOffset,high=-startOffset;   // the dx window that maps the sum onto the zone
 if(edge==='closed')return {edge,dx:high};          // exact negation, so the sum is exactly 0
 if(edge==='end-stop')return {edge,dx:low};         // exact at a resting start offset, so the sum is exactly endStop
 const fraction=rest==='between'?gen.float(0.02,0.98):gen.random();
 return {edge:'interior',dx:low+fraction*(high-low)};
}

/** Which boundaries this start offset can reach exactly. Only a resting offset can reach the end stop. */
function linearEdges(rest){
 return rest==='between'?['closed','interior','interior']:['closed','end-stop','interior','interior'];
}

function linearSample(gen,edges){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const {edge,dx}=linearDx(gen,rest,startOffset,endStop,gen.pick(edges??linearEdges(rest)));
 return {kind,rest,edge,endStop,startOffset,dx};
}

forAll('property 1: trackOffset tracks the finger one-to-one inside the linear zone',
 gen=>linearSample(gen),
 ({startOffset,dx,endStop})=>{
  const raw=startOffset+dx;                       // the exact sum the contract speaks about
  expect(raw).toBeGreaterThanOrEqual(endStop);    // the generator really landed inside the zone
  expect(raw).toBeLessThanOrEqual(0);
  expect(trackOffset(startOffset,dx,endStop)).toBe(raw);        // 1:1, no scaling or interpolation
  expect(trackOffset(startOffset,dx,endStop,false)).toBe(raw);  // the omitted flag is the false flag
  expect(trackOffset(startOffset,dx,endStop,true)).toBe(raw);   // inside the zone, reduced motion changes nothing
 });

forAll('property 1: the linear zone includes both of its boundaries',
 gen=>linearSample(gen,['closed','end-stop']),
 ({startOffset,dx,endStop,edge})=>{
  const raw=startOffset+dx;
  expect(raw).toBe(edge==='closed'?0:endStop);    // the boundary is hit exactly, not approached
  expect(trackOffset(startOffset,dx,endStop)).toBe(raw);
  expect(trackOffset(startOffset,dx,endStop,true)).toBe(raw);
 });

test('trackOffset returns the displacement itself across the linear zone of a real two-action row',()=>{
 const endStop=-2*ACTION_WIDTH_PX;               // -136, the End_Stop of a row with edit and delete
 expect(trackOffset(0,0,endStop)).toBe(0);                 // closed, untouched
 expect(trackOffset(0,-1,endStop)).toBe(-1);               // the first leftward pixel
 expect(trackOffset(0,-135.5,endStop)).toBe(-135.5);       // fractional offsets are not rounded
 expect(trackOffset(0,endStop,endStop)).toBe(endStop);     // the end-stop boundary, from closed
 expect(trackOffset(endStop,0,endStop)).toBe(endStop);      // the end-stop boundary, from open
 expect(trackOffset(endStop,40,endStop)).toBe(-96);         // an open row dragged back rightward
 expect(trackOffset(endStop,-endStop,endStop)).toBe(0);     // the closed boundary, from open
 expect(trackOffset(endStop,40,endStop,true)).toBe(-96);    // reduced motion tracks identically here
});
// ---------------------------------------------------------------------------
// Property 2: The rendered offset never escapes its bounds
// **Validates: Requirements 1.2, 3.2, 3.4, 3.5**
//
// The contract: for any start offset, any pointer displacement and any
// End_Stop, `trackOffset` returns at most `0` and at least `End_Stop - 48`;
// under Reduced_Motion it returns at least the End_Stop. Where property 1
// looks closely at the linear zone, this is the total-coverage statement, so
// the generator deliberately ranges over every region - unconstrained wide
// displacements in both directions, drags far past the end stop, drags far
// rightward past zero, zero displacement, and the boundaries themselves.
//
// The upper bound is requirements 3.4 and 3.5: a closed row dragged rightward
// holds at `0`, and an open row dragged rightward reaches `0` and holds. The
// lower bound is requirement 3.2, and it is tight - the 48px cap means the
// rendered value bottoms out at exactly `End_Stop - 48`, so samples that
// overshoot by 160px or more are generated on purpose to land on the floor
// rather than merely approach it.
// ---------------------------------------------------------------------------

/** The requirement 3.1 / 3.2 rubber band, named so the test states the contract itself. */
const RUBBER_MAX_PX=48,RUBBER_RESIST=0.3;
/** The raw overshoot at which 0.3 resistance first saturates the 48px cap: 160px past the End_Stop. */
const RUBBER_CAP_OVERSHOOT=RUBBER_MAX_PX/RUBBER_RESIST;

/** Which region of trackOffset a sample lands in, read off the raw sum rather than off the generator's intent. */
function boundsRegion(startOffset,dx,endStop){
 const raw=startOffset+dx;
 if(raw>=0)return 'clamped';
 if(raw>=endStop)return 'linear';
 return endStop-raw>=RUBBER_CAP_OVERSHOOT?'capped':'rubber';
}

/** A rightward displacement that carries the raw sum to or past zero, from a hair over to far beyond any real drag. */
function pastZeroDx(gen,startOffset){
 const past=gen.bool(0.4)?gen.pick([0,0.5,1,8,42,68,136,1000,1000000]):gen.float(0.5,5000);
 return {past,dx:past-startOffset};
}

/** A displacement per region: unconstrained, rightward past zero, inside the zone, or past the end stop. */
function boundsDx(gen,region,startOffset,endStop){
 if(region==='wild')return gen.sign()*(gen.bool(0.3)?gen.pick([0,1,48,68,136,160,480,5000]):gen.float(0,10000));
 if(region==='rightward')return pastZeroDx(gen,startOffset).dx;
 if(region==='zero')return 0;
 if(region==='closed-edge')return -startOffset;                                      // exact negation: the raw sum is exactly 0
 if(region==='end-stop')return endStop-startOffset;                                  // the raw sum is the End_Stop
 if(region==='linear')return endStop-startOffset+gen.random()*-endStop;              // somewhere inside the zone
 if(region==='rubber')return endStop-gen.float(0.001,RUBBER_CAP_OVERSHOOT)-startOffset;
 if(region==='cap-edge')return endStop-RUBBER_CAP_OVERSHOOT-startOffset;             // the overshoot that first reaches the cap
 return endStop-gen.float(RUBBER_CAP_OVERSHOOT,100000)-startOffset;                  // far past the cap
}

/** Every region, weighted toward unconstrained displacement because totality is the point of this property. */
const BOUNDS_REGIONS=['wild','wild','wild','rightward','rightward','zero','closed-edge','end-stop','linear','rubber','cap-edge','capped','capped'];

function boundsSample(gen){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const region=gen.pick(BOUNDS_REGIONS);
 const dx=boundsDx(gen,region,startOffset,endStop);
 return {kind,rest,region,landed:boundsRegion(startOffset,dx,endStop),endStop,startOffset,dx};
}

forAll('property 2: the rendered offset never escapes the range from the rubber-band floor to zero',
 gen=>boundsSample(gen),
 ({startOffset,dx,endStop})=>{
  const offset=trackOffset(startOffset,dx,endStop);
  const reduced=trackOffset(startOffset,dx,endStop,true);
  expect(Number.isFinite(offset)).toBe(true);
  expect(offset).toBeLessThanOrEqual(0);                          // never renders right of closed, requirements 3.4 / 3.5
  expect(offset).toBeGreaterThanOrEqual(endStop-RUBBER_MAX_PX);   // never past the 48px floor, requirement 3.2
  expect(trackOffset(startOffset,dx,endStop,false)).toBe(offset); // the omitted flag is the false flag
  expect(Number.isFinite(reduced)).toBe(true);
  expect(reduced).toBeLessThanOrEqual(0);
  expect(reduced).toBeGreaterThanOrEqual(endStop);                // reduced motion drops the band, so the end stop is a hard floor
  expect(offset).toBeLessThanOrEqual(reduced);                    // the band can only ever render further left
 });

test('the bounds generator visits every region of trackOffset, including the capped floor',()=>{
 const counts={clamped:0,linear:0,rubber:0,capped:0};
 runAll('property 2: the rendered offset never escapes the range from the rubber-band floor to zero',
  gen=>boundsSample(gen),
  ({landed})=>{counts[landed]+=1;});
 expect(counts.clamped).toBeGreaterThan(0);   // raw sum at or past zero
 expect(counts.linear).toBeGreaterThan(0);    // raw sum inside the zone
 expect(counts.rubber).toBeGreaterThan(0);    // inside the band, below the cap
 expect(counts.capped).toBeGreaterThan(0);    // overshoot of 160px or more, so the floor is genuinely exercised
});

/** A rightward drag from a resting offset, the two cases requirements 3.4 and 3.5 speak about. */
function rightwardSample(gen){
 const {kind,endStop}=linearEndStop(gen);
 const rest=gen.bool(0.5)?'closed':'open';
 const startOffset=rest==='closed'?0:endStop;
 const {past,dx}=pastZeroDx(gen,startOffset);
 return {kind,rest,past,endStop,startOffset,dx};
}

forAll('property 2: a row dragged rightward past zero holds the rendered offset at exactly zero',
 gen=>rightwardSample(gen),
 ({startOffset,dx,endStop})=>{
  expect(dx).toBeGreaterThanOrEqual(0);                            // the drag really is rightward
  expect(startOffset+dx).toBeGreaterThanOrEqual(0);                // and it really reached or passed zero
  expect(trackOffset(startOffset,dx,endStop)).toBe(0);             // closed holds at 0 (3.4), open reaches 0 and holds (3.5)
  expect(trackOffset(startOffset,dx,endStop,true)).toBe(0);        // reduced motion clamps identically
 });

forAll('property 2: an overshoot past the cap renders exactly at the rubber-band floor',
 gen=>{
  const {kind,endStop}=linearEndStop(gen);
  const rest=gen.bool(0.5)?'closed':'open';
  const startOffset=rest==='closed'?0:endStop;
  const overshoot=gen.bool(0.3)?gen.pick([161,200,480,1360,5000]):gen.float(RUBBER_CAP_OVERSHOOT+1,100000);
  return {kind,rest,overshoot,endStop,startOffset,dx:endStop-overshoot-startOffset};
 },
 ({startOffset,dx,endStop})=>{
  const overshoot=endStop-(startOffset+dx);
  expect(overshoot*RUBBER_RESIST).toBeGreaterThanOrEqual(RUBBER_MAX_PX);   // the sample really saturates the cap
  expect(trackOffset(startOffset,dx,endStop)).toBe(endStop-RUBBER_MAX_PX); // the floor is reached exactly, not approached
  expect(trackOffset(startOffset,dx,endStop,true)).toBe(endStop);          // under reduced motion the end stop holds instead
 });

test('trackOffset stays inside its bounds across a real two-action row',()=>{
 const endStop=-2*ACTION_WIDTH_PX;                        // -136, the End_Stop of a row with edit and delete
 expect(trackOffset(0,120,endStop)).toBe(0);              // a closed row dragged rightward holds at 0
 expect(trackOffset(endStop,500,endStop)).toBe(0);        // an open row dragged far rightward holds at 0
 expect(trackOffset(0,-166,endStop)).toBe(-145);          // 30px past the end stop renders 9px past it
 expect(trackOffset(0,-296,endStop)).toBe(endStop-RUBBER_MAX_PX);     // a 160px overshoot lands on the floor
 expect(trackOffset(0,-10000,endStop)).toBe(endStop-RUBBER_MAX_PX);   // and stays there however far the finger goes
 expect(trackOffset(0,-10000,endStop,true)).toBe(endStop);            // reduced motion holds the end stop
});
// ---------------------------------------------------------------------------
// Property 3: Rubber-band resistance is proportional and capped
// **Validates: Requirements 3.1, 3.2**
//
// The contract: for any raw sum `startOffset + dx` past the End_Stop, the row
// renders beyond the End_Stop by 0.3 times the raw overshoot (3.1), never by
// more than 48px (3.2), and `trackOffset` is monotonic in the raw sum.
// Monotonic means order-preserving: of two raw sums, the smaller one, further
// left, never renders to the right of the larger, so the rendered offset never
// increases while the finger keeps moving left.
//
// The overshoot is drawn well below the 160px point where 0.3 resistance first
// reaches the cap, a hair either side of it, exactly on it, and far beyond it.
// The expected distance always comes from the recomputed overshoot
// `endStop - (startOffset + dx)`, never from the overshoot the generator aimed
// at. The monotonicity pairs are anchored on each region boundary - the clamp
// at a raw sum of 0, the End_Stop, and 160px of overshoot - because that is
// where a discontinuity would hide. Pairs inside the band and pairs drawn from
// every region of property 2 complete the coverage.
//
// Floating point: the implementation renders `endStop - m`, with `m` the
// capped `Math.min(48, overshoot * 0.3)`, rounded to a double. Reading the
// distance back as `endStop - trackOffset(...)` therefore returns `m` plus that
// rounding, which is at most about half an ulp of `|endStop - m|`: some 2.3e-13
// for end stops near -4000 and 7.3e-12 at the generator's -100000 limit. The
// assertion allows 1e-9, over 100 times the worst case and still 3000 times
// smaller than a 1% error in the 0.3 ratio at the smallest drawn overshoot of
// 0.001px. An exact `toBe` against the implementation's own expression would
// pass too, but it would pin the order of floating-point operations rather
// than the property. Monotonicity is compared exactly, since rounding
// preserves order.
// ---------------------------------------------------------------------------

/** Each property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const RUBBER_PROPORTIONAL='property 3: past the end stop the row renders 0.3 of the raw overshoot beyond it, capped at 48px';
const RUBBER_MONOTONIC='property 3: trackOffset is monotonic, so of two raw sums the smaller never renders to the right of the larger';
/** Slack for reading the rendered distance back by subtraction. See the floating-point note above. */
const RUBBER_TOLERANCE_PX=1e-9;

/** An overshoot past the End_Stop: well below the 160px cap point, a hair either side of it, exactly on it, or far beyond. */
function rubberOvershoot(gen){
 const band=gen.pick(['below','below','near','at','beyond','beyond']);
 if(band==='below')return {band,overshoot:gen.bool(0.3)?gen.pick([0.001,0.5,1,9,30,68,100,136]):gen.float(0.001,150)};
 if(band==='near')return {band,overshoot:RUBBER_CAP_OVERSHOOT+gen.sign()*gen.pick([1e-6,0.001,0.1,1])};
 if(band==='at')return {band,overshoot:RUBBER_CAP_OVERSHOOT};
 return {band,overshoot:gen.bool(0.3)?gen.pick([161,200,480,1360,5000,100000,1000000]):gen.float(RUBBER_CAP_OVERSHOOT,100000)};
}

function rubberSample(gen){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const {band,overshoot}=rubberOvershoot(gen);
 return {kind,rest,band,overshoot,endStop,startOffset,dx:endStop-overshoot-startOffset};
}

forAll(RUBBER_PROPORTIONAL,
 gen=>rubberSample(gen),
 ({startOffset,dx,endStop})=>{
  const raw=startOffset+dx,overshoot=endStop-raw;   // recomputed, not the overshoot the generator aimed at
  expect(raw).toBeLessThan(endStop);                 // the sample really sits past the end stop
  const beyond=endStop-trackOffset(startOffset,dx,endStop);
  expect(Math.abs(beyond-Math.min(RUBBER_MAX_PX,overshoot*RUBBER_RESIST))).toBeLessThanOrEqual(RUBBER_TOLERANCE_PX);
 });

/** How far a pair member sits from its anchor: exactly on it, a rounding hair off it, or a real drag away. */
function anchorGap(gen){return gen.bool(0.3)?0:gen.bool(0.5)?gen.pick([1e-9,1e-6,0.001,0.5,1]):gen.float(0,40);}

/** Where a pair is anchored: on each region boundary, inside the band, or nowhere in particular. */
const MONOTONE_ANCHORS=['zero','end-stop','cap','band','wild'];

/** Two displacements over one start offset: either side of the anchor, or two independent drags from every region. */
function monotonePair(gen,anchor,startOffset,endStop){
 if(anchor==='wild')return [boundsDx(gen,gen.pick(BOUNDS_REGIONS),startOffset,endStop),boundsDx(gen,gen.pick(BOUNDS_REGIONS),startOffset,endStop)];
 const raw=anchor==='zero'?0:anchor==='end-stop'?endStop:anchor==='cap'?endStop-RUBBER_CAP_OVERSHOOT:endStop-gen.float(0,RUBBER_CAP_OVERSHOOT);
 return [raw-anchorGap(gen)-startOffset,raw+anchorGap(gen)-startOffset];   // a gap of 0 lands exactly on the anchor
}

function monotoneSample(gen){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const anchor=gen.pick(MONOTONE_ANCHORS);
 const pair=monotonePair(gen,anchor,startOffset,endStop);
 if(gen.bool(0.5))pair.reverse();   // hand the pair over in either order, so the property must sort it itself
 return {kind,rest,anchor,endStop,startOffset,dxA:pair[0],dxB:pair[1]};
}

forAll(RUBBER_MONOTONIC,
 gen=>monotoneSample(gen),
 ({startOffset,dxA,dxB,endStop})=>{
  const [lower,upper]=startOffset+dxA<=startOffset+dxB?[dxA,dxB]:[dxB,dxA];   // sorted by the recomputed raw sums
  expect(trackOffset(startOffset,lower,endStop)).toBeLessThanOrEqual(trackOffset(startOffset,upper,endStop));
 });

test('the property 3 generators reach every overshoot band and straddle every region boundary',()=>{
 const bands={below:0,at:0,beyond:0};
 runAll(RUBBER_PROPORTIONAL,gen=>rubberSample(gen),({startOffset,dx,endStop})=>{
  const overshoot=endStop-(startOffset+dx);
  bands[overshoot<RUBBER_CAP_OVERSHOOT?'below':overshoot===RUBBER_CAP_OVERSHOOT?'at':'beyond']+=1;
 });
 expect(bands.below).toBeGreaterThan(0);    // proportional, under the cap
 expect(bands.at).toBeGreaterThan(0);       // a recomputed overshoot of exactly 160px, where the ratio first meets the cap
 expect(bands.beyond).toBeGreaterThan(0);   // saturated
 const straddles={zero:0,endStop:0,cap:0},onBoundary={zero:0,endStop:0,cap:0};
 runAll(RUBBER_MONOTONIC,gen=>monotoneSample(gen),({startOffset,dxA,dxB,endStop})=>{
  const landed=new Set([boundsRegion(startOffset,dxA,endStop),boundsRegion(startOffset,dxB,endStop)]);
  if(landed.has('linear')&&landed.has('clamped'))straddles.zero+=1;
  if(landed.has('rubber')&&landed.has('linear'))straddles.endStop+=1;
  if(landed.has('capped')&&landed.has('rubber'))straddles.cap+=1;
  for(const raw of [startOffset+dxA,startOffset+dxB]){
   if(raw===0)onBoundary.zero+=1;
   if(raw===endStop)onBoundary.endStop+=1;
   if(endStop-raw===RUBBER_CAP_OVERSHOOT)onBoundary.cap+=1;
  }
 });
 expect(straddles.zero).toBeGreaterThan(0);      // one member linear, the other clamped
 expect(straddles.endStop).toBeGreaterThan(0);   // one in the band, the other linear
 expect(straddles.cap).toBeGreaterThan(0);       // one capped, the other still proportional
 expect(onBoundary.zero).toBeGreaterThan(0);     // and members land exactly on each boundary, not only near it
 expect(onBoundary.endStop).toBeGreaterThan(0);
 expect(onBoundary.cap).toBeGreaterThan(0);
});

test('trackOffset renders three tenths of the overshoot past a real two-action row, up to 48px',()=>{
 const endStop=-2*ACTION_WIDTH_PX;                         // -136, the End_Stop of a row with edit and delete
 expect(trackOffset(0,-146,endStop)).toBe(-139);           // 10px past the end stop renders 3px past it
 expect(trackOffset(0,-236,endStop)).toBe(-166);           // 100px renders 30px
 expect(trackOffset(endStop,-150,endStop)).toBe(-181);     // the same ratio from an open row: 150px renders 45px
 expect(trackOffset(endStop,-500,endStop)).toBe(endStop-RUBBER_MAX_PX);   // 500px past saturates at the 48px cap
});
// ---------------------------------------------------------------------------
// Property 9: Reduced motion changes only the rubber band
// **Validates: Requirements 6.2, 6.3**
//
// The contract: for any start offset, any displacement and any End_Stop, the
// Reduced_Motion flag leaves `trackOffset` unchanged wherever the clamped sum
// lies between the End_Stop and zero (6.2), and wherever the raw sum lies past
// the End_Stop the flag renders exactly the End_Stop (6.3). The clamped sum is
// `min(startOffset + dx, 0)`, and it lies in that range exactly when the raw
// sum is at least the End_Stop, so one comparison puts every sample in one
// half or the other. The first half is the linear zone plus the clamp at or
// past zero. The second is the whole rubber band, short of the 48px cap and
// beyond it.
//
// Properties 1 and 2 already check the flag inside the linear zone, at the
// clamp from a resting offset, and against the bounds, but they pin its exact
// value past the End_Stop only for overshoots of 161px or more. That leaves
// the band short of the cap open, including the hair just past the End_Stop
// where the flag first takes effect. So half the samples come from every
// region of property 2, and the other half sit on the End_Stop edge: exactly
// on it, which takes the unchanged branch, or to either side of it by one
// rounding step (the adjacent double) or by a hair of 1e-9 to 0.001px. Each
// sample's half is read off the recomputed raw sum through `boundsRegion`,
// never off the region the generator aimed at, because rounding in
// `startOffset + dx` can carry an edge sample from a mid-zone start offset
// across the boundary.
//
// Both halves compare exactly. The first compares two calls that must take
// the same branch, and the second compares against `endStop` itself, which is
// what the reduced branch returns. One rounding step past the End_Stop, the
// band itself rounds back onto the End_Stop, because 0.3 of a step is less
// than half a step. So at the step the two calls agree and the sample tests
// only where the boundary falls; the larger hairs are where the band and the
// End_Stop come apart.
// ---------------------------------------------------------------------------

/** The property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const REDUCED_ONLY_BAND='property 9: reduced motion changes trackOffset only past the end stop, where it holds the row at exactly the end stop';

/** One 64-bit slot seen both as a double and as its bit pattern, for stepping a double by whole representable values. */
const STEP_FLOAT=new Float64Array(1),STEP_BITS=new BigUint64Array(STEP_FLOAT.buffer);
/** The double `steps` representable values further from zero than a non-zero `x`. A negative count steps toward zero. */
function ulpStep(x,steps){STEP_FLOAT[0]=x;STEP_BITS[0]+=BigInt(steps);return STEP_FLOAT[0];}

/** An End_Stop edge other than the End_Stop itself: one rounding step or a small hair, past it or back inside the zone. */
const END_STOP_HAIRS=['step-past','hair-past','step-inside','hair-inside'];

/** A displacement aimed one step or one hair to either side of the End_Stop. The property reads back where it really landed. */
function hairDx(gen,hair,startOffset,endStop){
 const side=hair.endsWith('past')?1:-1;   // +1 aims past the End_Stop, -1 back inside the zone
 const target=hair.startsWith('step')?ulpStep(endStop,side):endStop-side*gen.pick([1e-9,1e-6,0.001]);
 return target-startOffset;
}

/** Half the samples from every region of property 2, half on the End_Stop edge: exactly on it, or a step or a hair either side. */
function reducedSample(gen){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const region=gen.bool(0.5)?gen.pick(BOUNDS_REGIONS):gen.pick(['end-stop',...END_STOP_HAIRS]);
 const dx=END_STOP_HAIRS.includes(region)?hairDx(gen,region,startOffset,endStop):boundsDx(gen,region,startOffset,endStop);
 return {kind,rest,region,landed:boundsRegion(startOffset,dx,endStop),endStop,startOffset,dx};
}

forAll(REDUCED_ONLY_BAND,
 gen=>reducedSample(gen),
 ({startOffset,dx,endStop})=>{
  const reduced=trackOffset(startOffset,dx,endStop,true);
  const region=boundsRegion(startOffset,dx,endStop);   // read off the recomputed raw sum, never off the region aimed at
  if(region==='clamped'||region==='linear')expect(reduced).toBe(trackOffset(startOffset,dx,endStop,false));   // 6.2: the flag changes nothing here
  else expect(reduced).toBe(endStop);                                                                          // 6.3: past the end stop it holds exactly there
 });

test('the property 9 generator reaches every region and lands on the end stop, one step from it, and a hair from it',()=>{
 const reached={clamped:0,linear:0,rubber:0,capped:0,onEndStop:0,stepPast:0,stepInside:0,hairPast:0,hairInside:0};
 runAll(REDUCED_ONLY_BAND,gen=>reducedSample(gen),({startOffset,dx,endStop})=>{
  const raw=startOffset+dx,region=boundsRegion(startOffset,dx,endStop);
  reached[region]+=1;
  if(raw===endStop){reached.onEndStop+=1;expect(region).toBe('linear');}                  // the boundary takes the unchanged branch
  else if(raw===ulpStep(endStop,1)){reached.stepPast+=1;expect(region).toBe('rubber');}   // the next double past it takes the reduced one
  else if(raw===ulpStep(endStop,-1))reached.stepInside+=1;
  else if(Math.abs(raw-endStop)<=0.001)reached[raw<endStop?'hairPast':'hairInside']+=1;
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names any region or edge the generator missed
 for(const endStop of [-136,-128,-0.001,-100000]){   // -128 is a power of two, where the step toward zero is half the size
  const past=ulpStep(endStop,1),inside=ulpStep(endStop,-1);
  expect(past).toBeLessThan(endStop);
  expect(inside).toBeGreaterThan(endStop);
  expect([past,endStop]).toContain((past+endStop)/2);       // each midpoint rounds onto an end, so no double lies between
  expect([inside,endStop]).toContain((inside+endStop)/2);
 }
});

test('reduced motion holds a real two-action row at its end stop for drags the band would stretch',()=>{
 const endStop=-2*ACTION_WIDTH_PX;                              // -136, the End_Stop of a row with edit and delete
 expect(trackOffset(0,-146,endStop,true)).toBe(endStop);        // 10px past, where the band renders -139
 expect(trackOffset(0,-236,endStop,true)).toBe(endStop);        // 100px past, where the band renders -166
 expect(trackOffset(endStop,-150,endStop,true)).toBe(endStop);  // 150px past an open row, where the band renders -181
 expect(trackOffset(endStop,-1,endStop,true)).toBe(endStop);    // an open row nudged 1px further left
});
// ---------------------------------------------------------------------------
// Property 5: Velocity depends only on the final 100ms and is undefined below two samples
// **Validates: Requirements 2.1, 2.2, 5.1, 5.2**
//
// The contract: for any sample sequence, `sampleVelocity` returns the same
// value as it does for the subsequence of samples within 100ms of the last
// sample, and it returns `null`, the not-measured value, for fewer than two
// samples or for a window that collapses to a single instant. Within 100ms
// means `last.t - s.t <= 100`, so a sample exactly 100ms older than the last
// is inside the window and one a single representable step older is not.
//
// `null` is the hinge of the legacy path. The swipe test in `tests/app.e2e.js`
// dispatches `pointerdown` then `pointerup` with no move between them, so the
// buffer is empty, `sampleVelocity` returns `null`, and `resolveRelease` takes
// the 56px/42px distance rule (5.1, 5.2). A `0` there would mean a measured,
// stationary finger and send the release to the halfway rule, which leaves
// that row closed. So every not-measured case asserts `toBeNull()`, never a
// falsy value, and a real stationary hold is asserted to be exactly `0`.
//
// Timestamps are generated the way the tracker records them: non-decreasing
// from a `performance.now()` origin of at least 200ms, on an unrounded clock,
// a 0.1ms clock, or a clock coarsened to whole milliseconds, with steps of 0
// (two events on one tick), 1 to 16.7ms, about one 60Hz frame, and pauses
// longer than the window. Positions drift left, drift right or hold still,
// with jitter and the odd reversal. Half the window traces also get a sample
// pinned exactly 100ms older than the last, or one representable step older
// than that. Subtracting 100 from a timestamp of at least 100ms is exact,
// because 100 is a multiple of the timestamp's ulp, so the pinned ages come
// out at exactly 100 and at exactly 100 plus one step.
//
// Every comparison is exact. Floating-point subtraction is monotonic, so along
// a non-decreasing trace `last.t - s.t` never increases and the samples inside
// the window form a suffix of the trace. The implementation's backward walk,
// the filtered subsequence and the oracle's forward search therefore all pick
// the same oldest sample, and the velocity is the same expression over the
// same two samples.
// ---------------------------------------------------------------------------

/** The Release_Velocity window and one 60Hz frame, named so the tests state the contract themselves. */
const VELOCITY_WINDOW_MS=100,FRAME_MS=1000/60;
/** Each property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const VELOCITY_FINAL_WINDOW='property 5: sampleVelocity gives the same value as it gives for the samples within 100ms of the last one';
const VELOCITY_OLD_SAMPLES='property 5: prepending samples more than 100ms older than the last one leaves the velocity unchanged';
/** How a browser can report `performance.now()`: unrounded, in 0.1ms ticks, or coarsened to whole milliseconds. */
const VELOCITY_CLOCKS={fine:t=>t,'0.1ms':t=>Math.round(t*10)/10,'1ms':Math.floor};

/** Whether a sample counts toward the velocity: at most 100ms older than the last sample, so exactly 100ms is inside. */
function inVelocityWindow(last,sample){return last.t-sample.t<=VELOCITY_WINDOW_MS;}

/** The oracle: the rate from the oldest in-window sample to the last, found by a forward search, or null on a single instant. */
function velocityOracle(trace){
 if(trace.length<2)return null;
 const last=trace[trace.length-1],oldest=trace.find(sample=>inVelocityWindow(last,sample));
 const dt=last.t-oldest.t;
 return dt>0?(last.x-oldest.x)/dt:null;
}

/** Whether timestamps never decrease along a trace, which is how the tracker records them. */
function nonDecreasing(trace){return trace.every((sample,i)=>i===0||trace[i-1].t<=sample.t);}

/** A `performance.now()` reading at the first sample: seconds, minutes, or a day into the page's life. */
function velocityOrigin(gen){return gen.float(...gen.pick([[200,5000],[5000,1e6],[1e6,1e8]]));}

/** The time to the next sample: none (two events on one tick), 1 to 16.7ms, about one 60Hz frame, or a pause past the window. */
function velocityStep(gen){
 const kind=gen.pick(['same','sub-frame','frame','frame','pause']);
 if(kind==='same')return 0;
 if(kind==='sub-frame')return gen.float(1,16.7);
 if(kind==='frame')return FRAME_MS+gen.float(-1,1);
 return VELOCITY_WINDOW_MS+gen.float(0.001,900);
}

/** A trace as the tracker records it, `{x,t}` from a `performance.now()` origin, with the finger drifting left, right, or still. */
function velocityTrace(gen,length){
 const clock=gen.pick(Object.keys(VELOCITY_CLOCKS)),drift=gen.pick(['left','right','still']);
 let now=velocityOrigin(gen),x=gen.float(0,390),rate=drift==='still'?0:(drift==='left'?-1:1)*gen.float(0.01,2.5);   // px/ms
 const trace=[];
 for(let i=0;i<length;i+=1){
  if(i>0){
   const step=velocityStep(gen);
   now+=step;
   if(drift!=='still'){if(gen.bool(0.15))rate=-rate;x+=rate*Math.min(step,FRAME_MS)+gen.float(-1,1);}   // jitter and the odd reversal
  }
  trace.push({x,t:VELOCITY_CLOCKS[clock](now)});
 }
 return {clock,drift,trace};
}

/** Insert a sample exactly 100ms older than the last, or one representable step older than that, keeping the order. */
function pinWindowEdge(gen,trace,edge){
 const last=trace[trace.length-1],at=last.t-VELOCITY_WINDOW_MS;   // exact, as the note above explains
 const t=edge==='at-window'?at:ulpStep(at,-1);
 trace.splice(trace.findIndex(sample=>sample.t>t),0,{x:last.x+gen.float(-40,40),t});
}

function windowSample(gen){
 const {clock,drift,trace}=velocityTrace(gen,gen.bool(0.4)?gen.pick([0,1,1,2,3]):gen.int(4,30));
 const edge=trace.length?gen.pick(['none','none','at-window','past-window']):'none';
 if(edge!=='none')pinWindowEdge(gen,trace,edge);
 return {clock,drift,edge,trace};
}

forAll(VELOCITY_FINAL_WINDOW,
 gen=>windowSample(gen),
 ({trace})=>{
  expect(nonDecreasing(trace)).toBe(true);                   // the generator really records time the way the tracker does
  const last=trace[trace.length-1],velocity=sampleVelocity(trace);
  expect(velocity).toBe(sampleVelocity(last?trace.filter(sample=>inVelocityWindow(last,sample)):[]));   // only the window matters
  expect(velocity).toBe(velocityOracle(trace));              // and the value is the rate from its oldest sample to the last
 });

/** Up to `count` timestamps more than 100ms older than the last of `recent` and none newer than its first, oldest first. */
function olderTimes(gen,recent,count){
 const last=recent[recent.length-1],times=[];
 let t=Math.min(recent[0].t,ulpStep(last.t-VELOCITY_WINDOW_MS,-1));   // one representable step outside the window, or older
 if(gen.bool(0.5))t-=velocityStep(gen);                                 // half the time the newest of them sits further out
 for(let i=0;i<count&&t>=0;i+=1){times.unshift(t);t-=velocityStep(gen);}
 return times;
}

function olderSample(gen){
 const {clock,drift,trace:recent}=velocityTrace(gen,gen.bool(0.3)?1:gen.int(2,20));
 const older=olderTimes(gen,recent,gen.int(1,12)).map(t=>({x:gen.float(-2000,2000),t}));   // anywhere at all, since the window drops them
 return {clock,drift,older,recent};
}

forAll(VELOCITY_OLD_SAMPLES,
 gen=>olderSample(gen),
 ({older,recent})=>{
  const last=recent[recent.length-1],velocity=sampleVelocity(recent);
  expect(nonDecreasing([...older,...recent])).toBe(true);
  for(const sample of older)expect(last.t-sample.t).toBeGreaterThan(VELOCITY_WINDOW_MS);   // the generator really stayed outside the window
  for(let k=1;k<=older.length;k+=1)expect(sampleVelocity([...older.slice(-k),...recent])).toBe(velocity);   // prepend any number of them
 });

test('the property 5 generators reach every clock and step, both window edges, and every outcome',()=>{
 const reached={fine:0,'0.1ms':0,'1ms':0,empty:0,single:0,sameInstant:0,pause:0,outsideWindow:0,atWindow:0,hairPastWindow:0,
  notMeasured:0,stationary:0,leftward:0,rightward:0,reversal:0,olderAtEdge:0,olderBeforeNull:0,olderBeforeMeasured:0};
 const hairPast=age=>age>VELOCITY_WINDOW_MS&&age<=VELOCITY_WINDOW_MS+1e-6;
 runAll(VELOCITY_FINAL_WINDOW,gen=>windowSample(gen),({clock,trace})=>{
  reached[clock]+=1;
  if(trace.length<2){reached[trace.length?'single':'empty']+=1;return;}
  const last=trace[trace.length-1],velocity=sampleVelocity(trace);
  trace.forEach((sample,i)=>{
   const age=last.t-sample.t,step=i?sample.t-trace[i-1].t:-1;
   if(step===0)reached.sameInstant+=1;
   if(step>VELOCITY_WINDOW_MS)reached.pause+=1;
   if(age>VELOCITY_WINDOW_MS)reached.outsideWindow+=1;
   if(age===VELOCITY_WINDOW_MS)reached.atWindow+=1;           // exactly 100ms old
   if(hairPast(age))reached.hairPastWindow+=1;                // older than 100ms by no more than a nanosecond
  });
  if(velocity===null)reached.notMeasured+=1;
  else reached[velocity===0?'stationary':velocity<0?'leftward':'rightward']+=1;
  const moves=trace.slice(1).map((sample,i)=>Math.sign(sample.x-trace[i].x));
  if(moves.includes(1)&&moves.includes(-1))reached.reversal+=1;
 });
 runAll(VELOCITY_OLD_SAMPLES,gen=>olderSample(gen),({older,recent})=>{
  if(!older.length)return;
  if(hairPast(recent[recent.length-1].t-older[older.length-1].t))reached.olderAtEdge+=1;
  reached[sampleVelocity(recent)===null?'olderBeforeNull':'olderBeforeMeasured']+=1;
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything a generator missed
});

/** A trace with nothing to measure: no samples, one, or a window collapsed onto the last instant, after any older samples. */
function collapsedSample(gen){
 const kind=gen.pick(['empty','single','one-instant','older-then-single','older-then-one-instant']);
 if(kind==='empty')return {kind,trace:[]};
 const t=VELOCITY_CLOCKS[gen.pick(Object.keys(VELOCITY_CLOCKS))](velocityOrigin(gen));
 const instant=Array.from({length:kind.endsWith('single')?1:gen.int(2,6)},()=>({x:gen.float(0,390),t}));
 const older=kind.startsWith('older')?olderTimes(gen,instant,gen.int(1,10)).map(time=>({x:gen.float(0,390),t:time})):[];
 return {kind,trace:[...older,...instant]};
}

forAll('property 5: sampleVelocity is null, never 0, for fewer than two samples or a window collapsed onto one instant',
 gen=>collapsedSample(gen),
 ({trace})=>{
  const last=trace[trace.length-1];
  for(const sample of trace)expect(sample.t===last.t||last.t-sample.t>VELOCITY_WINDOW_MS).toBe(true);   // the window really holds one instant
  expect(sampleVelocity(trace)).toBeNull();
 });

/** A finger moving one way through the whole window, sometimes after older samples from a drag the other way. */
function directionSample(gen){
 const direction=gen.sign(),tick=VELOCITY_CLOCKS[gen.pick(Object.keys(VELOCITY_CLOCKS))];   // -1 leftward, +1 rightward
 let now=velocityOrigin(gen),x=gen.float(0,390);
 const recent=[{x,t:tick(now)}];
 // At most five steps of at most 17.7ms, so the whole run sits inside the window. The first is at least 1ms, which every clock keeps.
 for(let i=0,moves=gen.int(1,5);i<moves;i+=1){
  now+=i>0&&gen.bool(0.2)?0:gen.float(1,FRAME_MS+1);
  x+=direction*gen.float(0.01,40);
  recent.push({x,t:tick(now)});
 }
 // Before turning, the finger came back from further along `direction`, so the older samples point the other way.
 const older=gen.bool(0.5)?olderTimes(gen,recent,gen.int(1,8)).map(t=>({x:recent[0].x+direction*gen.float(1,300),t})):[];
 return {direction,trace:[...older,...recent]};
}

forAll('property 5: a finger moving left measures a negative velocity and one moving right a positive velocity',
 gen=>directionSample(gen),
 ({direction,trace})=>{
  const velocity=sampleVelocity(trace);
  expect(velocity).not.toBeNull();               // the window holds real travel over real time
  expect(Math.sign(velocity)).toBe(direction);   // negative leftward and positive rightward, the sign resolveRelease reads
 });

test('the window keeps a sample exactly 100ms older than the last and drops one a hair older',()=>{
 // Whole and half milliseconds are exact doubles, so 5000.5 - 4900.5 is exactly 100.
 expect(sampleVelocity([{x:250,t:4900.5},{x:200,t:5000.5}])).toBe(-0.5);                      // exactly 100ms old: used
 expect(sampleVelocity([{x:400,t:4899.5},{x:250,t:4900.5},{x:200,t:5000.5}])).toBe(-0.5);      // 101ms old: dropped, so the 100ms sample is the oldest used
 const hair=ulpStep(4900.5,-1);                                                               // the next double below 4900.5
 expect(5000.5-hair).toBe(VELOCITY_WINDOW_MS+2**-40);                                         // exactly 100ms plus one step of 2^-40ms
 expect(sampleVelocity([{x:400,t:hair},{x:200,t:5000.5}])).toBeNull();                        // dropped, which leaves the last sample alone
 expect(sampleVelocity([{x:400,t:hair},{x:225,t:4950.5},{x:200,t:5000.5}])).toBe(-0.5);       // and the next sample in is the oldest used
});

test('sampleVelocity returns null, never 0, when there is no rate to measure, and exactly 0 for a finger held still',()=>{
 expect(sampleVelocity([])).toBeNull();                                                       // pointerdown then pointerup with no move: the tests/app.e2e.js gesture
 expect(sampleVelocity(null)).toBeNull();
 expect(sampleVelocity(undefined)).toBeNull();
 expect(sampleVelocity([{x:200,t:5000}])).toBeNull();                                         // one position carries no rate
 expect(sampleVelocity([{x:200,t:5000},{x:120,t:5000}])).toBeNull();                          // two samples on one instant would divide by zero
 expect(sampleVelocity([{x:200,t:5000},{x:160,t:5000},{x:120,t:5000}])).toBeNull();
 expect(sampleVelocity([{x:300,t:4000},{x:200,t:5000},{x:120,t:5000}])).toBeNull();           // an older sample cannot rescue a window collapsed onto one instant
 expect(sampleVelocity([{x:300,t:4000},{x:200,t:4880},{x:120,t:5000}])).toBeNull();           // every earlier sample is over 100ms older than the last
 expect(sampleVelocity([{x:200,t:4984},{x:200,t:5000}])).toBe(0);                             // a real stationary hold is measured, and it is exactly 0
});

test('a real 60Hz flick measures its own direction over the final 100ms, whatever came before',()=>{
 const frames=(x0,dx,count,t0=5000)=>Array.from({length:count},(_,i)=>({x:x0+dx*i,t:t0+16*i}));
 expect(sampleVelocity(frames(300,-12,8))).toBe(-0.75);     // 12px left per 16ms frame: -72px over the final 96ms
 expect(sampleVelocity(frames(100,12,8))).toBe(0.75);       // the same flick rightward
 const turn=[...frames(300,-10,12),...frames(190,15,6,5192)];   // 176ms of slow leftward drag, then a rightward flick
 expect(sampleVelocity(turn)).toBe(0.78125);                // +75px over the final 96ms, although the finger ends 35px left of where it began
});
// ---------------------------------------------------------------------------
// Property 6: A flick resolves by direction regardless of distance
// **Validates: Requirements 2.1, 2.2**
//
// The contract: for any Drag_Offset, any End_Stop and any Release_Velocity of
// at least 0.35px/ms in magnitude, `resolveRelease` resolves open when the
// velocity is leftward (2.1) and closed when it is rightward (2.2). The
// expected value is `velocity < 0` and nothing else. "Regardless of distance"
// is tested by drawing every other input free of the velocity, and often
// against it: the offset from the clamp at 0 through the linear zone to the
// rubber-band floor, on both sides of the halfway point; a total displacement
// of any size and sign, including far enough the other way that the
// release-only 56px/42px rule would resolve against the flick; the axis
// horizontal, vertical or unresolved; and the prior state open or closed. The
// self-check confirms that, in both directions, some samples have the offset,
// the displacement and the prior state all pointing the other way. "Any"
// includes a gesture whose axis locked vertical, which `resolveRelease` also
// resolves by direction; the design expects the browser to end a vertical pan
// with `pointercancel`, which keeps the prior state, rather than `pointerup`.
//
// The threshold is inclusive, and the boundary is pinned on both sides. 0.35
// has no exact double, but the literal here and the one in the source are the
// same double, so exactly ±0.35 and the next double up are drawn often and
// must resolve by direction. The double one step under 0.35 is the fastest
// release that is no flick. The second property draws it, and small decimal
// hairs under the threshold, and asserts that the halfway rule decides, with
// offsets on both sides of the halfway point so that the halfway rule and the
// direction often disagree.
//
// The inert-row exception: a row with no actions has an End_Stop of 0, and
// `resolveRelease` returns closed for it before it reads the velocity. So "any
// End_Stop" means any non-zero End_Stop, and the exception is asserted as a
// property of its own over the same flicks, for +0 and for -0, the value of
// -(swipeCount * 68) for a count of zero.
//
// Velocities are drawn as numbers. `resolveRelease` reads only the number, so
// how the release path measures it (properties 5 and 11) does not matter here.
// ---------------------------------------------------------------------------

/** The Flick_Threshold of requirements 2.1 / 2.2 in px/ms, and the release-only distances of 5.1 / 5.2 that a flick overrides. */
const FLICK_THRESHOLD_PX_MS=0.35,LEGACY_OPEN_PX=56,LEGACY_CLOSE_PX=42;
/** Each property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const FLICK_BY_DIRECTION='property 6: a flick of at least 0.35px/ms resolves by its direction alone, whatever the offset, displacement, axis or prior state';
const FLICK_HAIR_UNDER='property 6: a velocity a hair under 0.35px/ms is no flick, so the halfway rule decides instead of the direction';
const FLICK_INERT_ROW='property 6, inert-row exception: a row with no actions has an End_Stop of 0 and resolves closed even for a leftward flick';

/** The halfway rule of requirements 2.3 / 2.4: open when the Drag_Offset magnitude reaches half the End_Stop magnitude. */
function halfwayOpen(offset,endStop){return Math.abs(offset)>=Math.abs(endStop)/2;}

/** A flick speed: exactly the threshold, the next double up, a real finger's flick, or far faster than any finger. */
function flickSpeed(gen){
 const band=gen.pick(['threshold','threshold','step-over','real','real','fast']);
 if(band==='threshold')return FLICK_THRESHOLD_PX_MS;
 if(band==='step-over')return ulpStep(FLICK_THRESHOLD_PX_MS,1);
 if(band==='real')return gen.float(FLICK_THRESHOLD_PX_MS,5);
 return gen.bool(0.3)?gen.pick([10,1000,1e6,Number.MAX_VALUE]):gen.float(5,10000);
}

/** A speed a hair under the threshold: the double just under it, or a small decimal hair under it. */
function underFlickSpeed(gen){
 return gen.bool(0.5)?ulpStep(FLICK_THRESHOLD_PX_MS,-1):FLICK_THRESHOLD_PX_MS-gen.pick([1e-12,1e-9,1e-6,1e-3]);
}

/** A total displacement: the drag behind the offset, 56px or more against the flick, none, or anything at all. */
function flickTotalDx(gen,dx,direction){
 const kind=gen.pick(['gesture','against','against','zero','wild']);
 if(kind==='gesture')return dx;
 if(kind==='against')return -direction*gen.float(LEGACY_OPEN_PX,5000);   // far enough that the release-only rule would resolve against the flick
 if(kind==='zero')return 0;
 return gen.sign()*gen.float(0,10000);
}

/** Every resolveRelease input: a speed from `speedOf` in either direction, and every other input drawn free of it. */
function flickSample(gen,speedOf=flickSpeed){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const region=gen.pick(BOUNDS_REGIONS),dx=boundsDx(gen,region,startOffset,endStop);
 const direction=gen.sign();   // -1 leftward, +1 rightward
 return {kind,rest,region,landed:boundsRegion(startOffset,dx,endStop),offset:trackOffset(startOffset,dx,endStop),endStop,
  velocity:direction*speedOf(gen),totalDx:flickTotalDx(gen,dx,direction),totalDy:gen.bool(0.2)?0:gen.sign()*gen.float(0,10000),
  axis:gen.pick([...AXIS_LOCKS,null]),wasOpen:gen.bool()};
}

forAll(FLICK_BY_DIRECTION,
 gen=>flickSample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(endStop).toBeLessThan(0);                                           // a row with actions, so the inert-row exception is out of play
  expect(Math.abs(velocity)).toBeGreaterThanOrEqual(FLICK_THRESHOLD_PX_MS);  // the sample really is a flick
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(velocity<0);   // leftward opens (2.1), rightward closes (2.2)
 });

forAll(FLICK_HAIR_UNDER,
 gen=>flickSample(gen,underFlickSpeed),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(Math.abs(velocity)).toBeLessThan(FLICK_THRESHOLD_PX_MS);            // the sample really sits under the threshold
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(halfwayOpen(offset,endStop));   // the offset decides, not the direction
 });

/** The same flicks on a row with no actions: a real row's offset and inputs, released against an End_Stop of +0 or -0. */
function inertSample(gen){
 const {endStop:borrowed,...sample}=flickSample(gen);
 const zero=gen.pick(['+0','-0']);   // JSON prints -0 as 0, so the label says which zero the sample holds
 return {...sample,borrowed,zero,endStop:zero==='+0'?0:-0};
}

forAll(FLICK_INERT_ROW,
 gen=>inertSample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(endStop===0).toBe(true);                                            // +0 or -0, both falsy
  expect(Math.abs(velocity)).toBeGreaterThanOrEqual(FLICK_THRESHOLD_PX_MS);
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(false);   // closed, even where the direction says open
 });

test('the property 6 generators reach every speed, offset region and axis, both sides of the threshold, and flicks with every input against them',()=>{
 const over=ulpStep(FLICK_THRESHOLD_PX_MS,1),under=ulpStep(FLICK_THRESHOLD_PX_MS,-1);   // the doubles either side of 0.35
 const reached={atThreshold:0,stepOver:0,real:0,fast:0,clamped:0,linear:0,rubber:0,capped:0,horizontal:0,vertical:0,unresolved:0,
  thresholdLeftAgainstHalfway:0,thresholdRightAgainstHalfway:0,leftAgainstAll:0,rightAgainstAll:0,
  stepUnderLeftAgainstDirection:0,stepUnderRightAgainstDirection:0,decimalHairUnder:0,inertLeftPlusZero:0,inertLeftMinusZero:0};
 runAll(FLICK_BY_DIRECTION,gen=>flickSample(gen),({landed,offset,endStop,velocity,totalDx,axis,wasOpen})=>{
  const speed=Math.abs(velocity),left=velocity<0,halfway=halfwayOpen(offset,endStop);
  reached[speed===FLICK_THRESHOLD_PX_MS?'atThreshold':speed===over?'stepOver':speed<=5?'real':'fast']+=1;
  reached[landed]+=1;
  reached[axis??'unresolved']+=1;
  if(speed===FLICK_THRESHOLD_PX_MS&&halfway!==left)reached[left?'thresholdLeftAgainstHalfway':'thresholdRightAgainstHalfway']+=1;   // where `>` for `>=` would show
  const displacementAgainst=left?totalDx>=LEGACY_CLOSE_PX:totalDx<=-LEGACY_OPEN_PX;   // the release-only rule would resolve the other way
  if(halfway!==left&&displacementAgainst&&wasOpen!==left)reached[left?'leftAgainstAll':'rightAgainstAll']+=1;
 });
 runAll(FLICK_HAIR_UNDER,gen=>flickSample(gen,underFlickSpeed),({offset,endStop,velocity})=>{
  const speed=Math.abs(velocity),left=velocity<0;
  if(speed===under&&halfwayOpen(offset,endStop)!==left)reached[left?'stepUnderLeftAgainstDirection':'stepUnderRightAgainstDirection']+=1;   // where a lower threshold would show
  if(FLICK_THRESHOLD_PX_MS-speed>1e-13)reached.decimalHairUnder+=1;
 });
 runAll(FLICK_INERT_ROW,gen=>inertSample(gen),({endStop,velocity})=>{
  if(velocity<0)reached[Object.is(endStop,-0)?'inertLeftMinusZero':'inertLeftPlusZero']+=1;
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything a generator missed
 expect(under).toBeLessThan(FLICK_THRESHOLD_PX_MS);expect(over).toBeGreaterThan(FLICK_THRESHOLD_PX_MS);
 expect([under,FLICK_THRESHOLD_PX_MS]).toContain((under+FLICK_THRESHOLD_PX_MS)/2);   // each midpoint rounds onto an end, so no double
 expect([FLICK_THRESHOLD_PX_MS,over]).toContain((FLICK_THRESHOLD_PX_MS+over)/2);     // lies between the threshold and either neighbour
});

test('a flick decides a real two-action row by its direction, and one double under the threshold the halfway rule decides',()=>{
 const endStop=-2*ACTION_WIDTH_PX,under=ulpStep(FLICK_THRESHOLD_PX_MS,-1);   // -136, so halfway is a 68px drag; and the double just under 0.35
 // A horizontal drag of `dx` from a closed or an open row, released at `velocity`, at the offset the tracker would hold.
 const release=(wasOpen,dx,velocity)=>resolveRelease({offset:trackOffset(wasOpen?endStop:0,dx,endStop),endStop,velocity,totalDx:dx,totalDy:0,axis:'horizontal',wasOpen});
 expect(release(false,-20,-0.6)).toBe(true);    // a 20px flick left opens, short of the 68px halfway point and the 56px legacy distance
 expect(release(true,16,0.6)).toBe(false);      // a 16px flick right closes an open row that both of those rules would keep open
 expect(release(true,-40,0.5)).toBe(false);     // a rightward flick closes even from the rubber band, which the halfway rule opens (3.3)
 expect(release(false,-120,0.8)).toBe(false);   // a finger that turns back at the end closes the row it dragged 120px left
 expect(release(false,-10,-FLICK_THRESHOLD_PX_MS)).toBe(true);   // exactly 0.35px/ms is a flick, because the threshold is inclusive
 expect(release(true,10,FLICK_THRESHOLD_PX_MS)).toBe(false);     // in either direction
 expect(release(false,-10,-under)).toBe(false); // one double under it is no flick, so the halfway rule keeps a 10px drag closed
 expect(release(true,10,under)).toBe(true);     // and keeps an open row dragged back 10px open
});
// ---------------------------------------------------------------------------
// Property 7: Below the flick threshold the halfway rule decides
// **Validates: Requirements 2.3, 2.4, 3.3**
//
// The contract: for any Drag_Offset, any End_Stop and any Release_Velocity
// under 0.35px/ms in magnitude, `resolveRelease` resolves open when the
// offset magnitude is at least half the End_Stop magnitude (2.3) and closed
// when it is less (2.4). The expected value is always `halfwayOpen` of the
// offset the sample really holds, never the side a generator aimed for.
//
// The velocity is a number, never `null`, so the legacy rule is out of play.
// It spans the whole range under the threshold in both directions: exactly 0,
// which a leftward draw turns into -0, tiny speeds down to the smallest
// double, any slow speed, and a band just under the threshold. The double one
// step under 0.35 and the decimal hairs under it belong to property 6's second
// test and are not drawn again. Exactly 0 matters most: it is the measured,
// stationary finger that `releaseVelocity` reports after a pause, and reading
// it as not measured would hand that release to the 56px/42px rule.
//
// The offset alone must decide, so every other input is drawn against it.
// Half the samples point the velocity's direction, the total displacement and
// the prior state at the outcome the offset rules out: rightward, at least
// 42px rightward and closed when the offset opens; leftward, at least 56px
// leftward and open when it closes. A flick reading of the direction, the
// release-only rule on any axis, and the prior state would then each resolve
// the other way. The other half draw them freely, the displacement through
// property 6's `flickTotalDx`. The axis and the vertical displacement are
// always free. `flickSample` itself is not reused: it points its displacement
// against the velocity's direction, which the halfway rule ignores, so samples
// with the direction, the displacement and the prior state all against the
// offset would be rare. Its parts are reused instead.
//
// The first property draws the offset from every region of property 2: the
// clamp at 0, the linear zone, the rubber band and the capped floor. A
// continuous draw almost never lands on the halfway point itself, so the
// second property puts the offset on it or one double to either side.
// Halving a double changes only its exponent, so half of every End_Stop drawn
// is exact, for the shipped -(swipeCount * 68) and the arbitrary negatives
// alike, and a drag from a resting offset lands on it exactly. A drag from a
// mid-zone start offset can round onto a neighbour, which is why each sample
// is classified by its own offset. The boundary is inclusive: exactly half
// opens, and the next double toward 0 closes.
//
// Requirement 3.3 needs no branch of its own. An offset past the End_Stop has
// a larger magnitude than the End_Stop, so it is past half. The third
// property draws only offsets inside the rubber band and asserts open itself,
// not through `halfwayOpen`.
//
// The inert-row exception: as in property 6, "any End_Stop" means any
// non-zero End_Stop. An End_Stop of 0 resolves closed before the halfway rule,
// which would open it, since every magnitude is at least half of 0. Property
// 6 asserts that over flicks; the example test asserts it once.
// ---------------------------------------------------------------------------

/** Each property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const HALFWAY_DECIDES='property 7: under 0.35px/ms the halfway rule decides, whatever the speed, direction, displacement, axis or prior state';
const HALFWAY_INCLUSIVE='property 7: an offset of exactly half the end stop opens and the next double toward zero closes';
const HALFWAY_RUBBER_BAND='property 7: a slow release from inside the rubber band opens, because past the end stop is past half';
/** Where a boundary sample aims: on half the End_Stop, or one double toward zero or away from it. */
const HALFWAY_EDGES=['on','on','toward-zero','toward-zero','away'];
/** The regions of property 2 past the End_Stop: inside the band, where the band first reaches the cap, and on the floor. */
const RUBBER_RELEASE_REGIONS=['rubber','rubber','cap-edge','capped'];

/** A speed under the threshold: exactly zero, tiny, anywhere below 0.35px/ms, or in the band just under it. */
function slowSpeed(gen){
 const band=gen.pick(['zero','zero','tiny','slow','slow','near']);
 if(band==='zero')return 0;
 if(band==='tiny')return gen.bool(0.5)?gen.pick([Number.MIN_VALUE,1e-300,1e-12,1e-6]):gen.float(0,1e-3);
 if(band==='slow')return gen.float(0,FLICK_THRESHOLD_PX_MS);
 return gen.float(0.3,FLICK_THRESHOLD_PX_MS);   // continuous; the double just under 0.35 and the decimal hairs are property 6's
}

/** The inputs the halfway rule must ignore: half the time all pointing at the outcome the offset rules out, otherwise free. */
function slowInputs(gen,offset,endStop,dx){
 const open=halfwayOpen(offset,endStop),against=gen.bool(0.5);
 const direction=against?(open?1:-1):gen.sign();   // -1 leftward, +1 rightward. JSON prints -0 as 0, so this says which zero a zero speed gave
 return {against,direction,velocity:direction*slowSpeed(gen),
  totalDx:against?(open?gen.float(LEGACY_CLOSE_PX,5000):-gen.float(LEGACY_OPEN_PX,5000)):flickTotalDx(gen,dx,direction),
  totalDy:gen.bool(0.2)?0:gen.sign()*gen.float(0,10000),axis:gen.pick([...AXIS_LOCKS,null]),wasOpen:against?!open:gen.bool()};
}

/** A slow release at the offset a drag into `regions` of property 2 leaves, with every other input from `slowInputs`. */
function slowSample(gen,regions=BOUNDS_REGIONS){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const region=gen.pick(regions),dx=boundsDx(gen,region,startOffset,endStop),offset=trackOffset(startOffset,dx,endStop);
 return {kind,rest,region,landed:boundsRegion(startOffset,dx,endStop),offset,endStop,...slowInputs(gen,offset,endStop,dx)};
}

/** A slow release after a drag aimed at the halfway point or a double beside it. The property reads back where it really landed. */
function halfwayEdgeSample(gen){
 const {kind,endStop}=linearEndStop(gen);
 const {rest,startOffset}=linearStart(gen,endStop);
 const half=endStop/2,edge=gen.pick(HALFWAY_EDGES);   // exact, as the note above explains
 const dx=(edge==='on'?half:ulpStep(half,edge==='away'?1:-1))-startOffset,offset=trackOffset(startOffset,dx,endStop);
 return {kind,rest,edge,offset,endStop,...slowInputs(gen,offset,endStop,dx)};
}

forAll(HALFWAY_DECIDES,
 gen=>slowSample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(endStop).toBeLessThan(0);                                 // a row with actions, so the inert-row exception is out of play
  expect(typeof velocity).toBe('number');                          // measured, so the legacy rule is out of play too
  expect(Math.abs(velocity)).toBeLessThan(FLICK_THRESHOLD_PX_MS);  // and no flick
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(halfwayOpen(offset,endStop));   // open from half (2.3), closed below it (2.4)
 });

forAll(HALFWAY_INCLUSIVE,
 gen=>halfwayEdgeSample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(typeof velocity).toBe('number');
  expect(Math.abs(velocity)).toBeLessThan(FLICK_THRESHOLD_PX_MS);
  const open=resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen});
  expect(open).toBe(halfwayOpen(offset,endStop));               // classified by the offset the sample holds, not the edge it aimed at
  if(offset===endStop/2)expect(open).toBe(true);                // exactly half the End_Stop opens: the boundary is inclusive
  if(offset===ulpStep(endStop/2,-1))expect(open).toBe(false);   // and the next double toward zero closes
 });

forAll(HALFWAY_RUBBER_BAND,
 gen=>slowSample(gen,RUBBER_RELEASE_REGIONS),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(offset).toBeLessThan(endStop);                            // the offset really sits inside the rubber band, past the End_Stop
  expect(typeof velocity).toBe('number');
  expect(Math.abs(velocity)).toBeLessThan(FLICK_THRESHOLD_PX_MS);
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(true);   // 3.3: open, whatever else argues for closed
 });

test('the property 7 generators reach every speed band and offset region, the halfway point and the doubles beside it, and releases with every other input against the offset',()=>{
 const reached={plusZero:0,minusZero:0,tiny:0,slow:0,nearThreshold:0,clamped:0,linear:0,rubber:0,capped:0,
  openAgainstAll:0,closedAgainstAll:0,plusZeroAgainst:0,minusZeroAgainst:0,
  onHalfShipped:0,onHalfArbitrary:0,stepTowardZero:0,stepAway:0,zeroOnHalf:0,zeroStepTowardZero:0,
  bandRubber:0,bandCapped:0,bandZeroAgainst:0,bandAgainstAll:0};
 const speedBand=velocity=>{
  const speed=Math.abs(velocity);
  return speed===0?(Object.is(velocity,-0)?'minusZero':'plusZero'):speed<1e-3?'tiny':speed<0.3?'slow':'nearThreshold';
 };
 // The release-only rule would resolve against `open` on any axis: by the displacement when horizontal, by the prior state otherwise.
 const legacyAgainst=({totalDx,wasOpen},open)=>wasOpen!==open&&(open?totalDx>=LEGACY_CLOSE_PX:totalDx<=-LEGACY_OPEN_PX);
 runAll(HALFWAY_DECIDES,gen=>slowSample(gen),sample=>{
  const {landed,offset,endStop,velocity}=sample,open=halfwayOpen(offset,endStop),band=speedBand(velocity);
  reached[band]+=1;
  reached[landed]+=1;
  if(!legacyAgainst(sample,open))return;
  if(velocity===0)reached[band+'Against']+=1;                                         // where reading 0 as not measured would show
  else if((velocity<0)!==open)reached[open?'openAgainstAll':'closedAgainstAll']+=1;  // and where a flick reading of the direction would too
 });
 runAll(HALFWAY_INCLUSIVE,gen=>halfwayEdgeSample(gen),({offset,endStop,velocity})=>{
  const half=endStop/2;
  if(offset===half){
   expect(halfwayOpen(offset,endStop)).toBe(true);
   reached[SWIPE_COUNTS.includes(endStop/-ACTION_WIDTH_PX)?'onHalfShipped':'onHalfArbitrary']+=1;
   if(velocity===0)reached.zeroOnHalf+=1;
  }else if(offset===ulpStep(half,-1)){
   expect(halfwayOpen(offset,endStop)).toBe(false);
   reached.stepTowardZero+=1;
   if(velocity===0)reached.zeroStepTowardZero+=1;
  }else if(offset===ulpStep(half,1)){
   expect(halfwayOpen(offset,endStop)).toBe(true);
   reached.stepAway+=1;
  }
 });
 runAll(HALFWAY_RUBBER_BAND,gen=>slowSample(gen,RUBBER_RELEASE_REGIONS),sample=>{
  reached[sample.landed==='capped'?'bandCapped':'bandRubber']+=1;
  if(legacyAgainst(sample,true)&&sample.velocity>=0)reached[sample.velocity===0?'bandZeroAgainst':'bandAgainstAll']+=1;   // still or rightward, prior closed, displacement rightward
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything a generator missed
});

test('below the threshold a real two-action row resolves by its 68px halfway point, whatever the speed, direction, displacement or prior state',()=>{
 const endStop=-2*ACTION_WIDTH_PX,justShort=ulpStep(endStop/2,-1);   // -136, so halfway is a 68px drag; and the double just short of it
 // A horizontal drag of `dx` from a closed or an open row, released at `velocity`, at the offset the tracker would hold.
 const release=(wasOpen,dx,velocity)=>resolveRelease({offset:trackOffset(wasOpen?endStop:0,dx,endStop),endStop,velocity,totalDx:dx,totalDy:0,axis:'horizontal',wasOpen});
 expect(release(false,-68,0)).toBe(true);           // a 68px drag held still before lifting opens: exactly half is enough
 expect(release(false,justShort,-0)).toBe(false);   // one double short of 68px closes, though the release-only 56px rule would open it
 expect(release(false,-60,0)).toBe(false);          // a 60px drag held still closes; reading 0 as not measured would open it
 expect(release(true,60,0.34)).toBe(true);          // an open row dragged back 60px and let go slowly rightward stays open
 expect(release(true,100,-0.2)).toBe(false);        // dragged back 100px it closes, though the finger was drifting left
 expect(release(false,-166,0.3)).toBe(true);        // a slow release 9px into the rubber band opens (3.3)
 expect(resolveRelease({offset:-60,endStop:0,velocity:0,totalDx:-60,totalDy:0,axis:'horizontal',wasOpen:true})).toBe(false);   // a row with no actions stays closed, though any offset is half of 0
});
// ---------------------------------------------------------------------------
// Property 8: With no measurable velocity the legacy distance rule decides
// **Validates: Requirements 5.1, 5.2**
//
// The contract: for any horizontal displacement and any prior row state, when
// the velocity is `null`, the not-measured value, and the release axis is
// horizontal, `resolveRelease` resolves open when the displacement is at least
// 56px leftward (5.1), closed when it is at least 42px rightward (5.2), and to
// the prior state in between. The expected value is what `legacyVerdict` makes
// of the displacement the sample really holds, or the prior state where it
// decides nothing.
//
// The release axis is the axis lock, or, while the lock is unresolved,
// `resolveAxis` over the displacement from `pointerdown` to `pointerup`. Since
// task 4.5 the release path passes `null` only for a gesture with no
// `pointermove`, and such a gesture never resolves its lock, so a real release
// on this branch reads its axis off the displacement. That is the shape of the
// `tests/app.e2e.js` gesture, and 70% of the samples have it. Their vertical
// displacement is drawn under 1/1.25 of the horizontal one, which
// `resolveAxis` reads as horizontal once the horizontal one reaches 8px, so
// between the thresholds their horizontal displacement is at least 8px. The
// other 30% carry a horizontal lock, which `resolveRelease` accepts as well.
// Their vertical displacement is free, so the displacement alone often would
// not read horizontal, and between the thresholds they include the dead zone.
//
// The offset plays no part on this branch, so half the samples hold an offset
// on the side of the halfway point that resolves against the outcome and,
// wherever the displacement decides, a prior state against it too. A release
// that fell through to the halfway rule, or that kept the prior state, would
// then resolve the other way. The other half draw the offset from every region
// of property 2 and the prior state freely. End_Stops come from the shipped
// geometry and from arbitrary negatives.
//
// Both thresholds are inclusive. -56 and 42 are exact doubles, so the second
// property puts the displacement on each, or one double toward zero or away
// from it. Exactly 56px leftward opens, exactly 42px rightward closes, and the
// next double toward zero from either keeps the prior state.
//
// The third property draws releases whose axis is not horizontal: a vertical
// lock, or an unresolved lock over a displacement that `resolveAxis` reads as
// vertical, as the near-diagonal wedge, or as inside the 8px dead zone, from
// property 4's generators. Each keeps its prior state. That includes the many
// drawn past a threshold with the prior state against the displacement, and
// vertical locks over a displacement that alone would read horizontal.
//
// `null` is not 0. A velocity of 0 is a measured, stationary finger, and the
// halfway rule decides it (property 7). The example test releases the
// `tests/app.e2e.js` gesture both ways: `null` opens the row and 0 leaves it
// closed. As in properties 6 and 7, "any" End_Stop means any non-zero one. An
// End_Stop of 0 resolves closed before the velocity is read, and the example
// test asserts that once.
// ---------------------------------------------------------------------------

/** Each property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const LEGACY_DECIDES='property 8: with no measured velocity and a horizontal release axis, 56px leftward opens, 42px rightward closes, and the prior state stands in between';
const LEGACY_INCLUSIVE='property 8: exactly 56px leftward opens and exactly 42px rightward closes, and the next double toward zero from either keeps the prior state';
const LEGACY_OFF_AXIS='property 8: with no measured velocity a release whose axis is not horizontal keeps the prior state, whatever the displacement';
/** Where a boundary sample aims: on a threshold, or one double toward zero or away from it. */
const LEGACY_EDGES=['on','on','toward-zero','toward-zero','away'];

/** What the displacement alone decides under requirements 5.1 / 5.2: open from 56px leftward, closed from 42px rightward, and nothing in between. */
function legacyVerdict(totalDx){return totalDx<=-LEGACY_OPEN_PX?true:totalDx>=LEGACY_CLOSE_PX?false:null;}

/** A total displacement in one band of the rule. Between the thresholds a lock needs no travel, while an unresolved lock needs 8px to read as horizontal. */
function legacyTotalDx(gen,band,locked){
 if(band==='open')return gen.bool(0.3)?gen.pick([-56,-57,-85,-136,-408,-1e6]):-gen.float(LEGACY_OPEN_PX,5000);
 if(band==='close')return gen.bool(0.3)?gen.pick([42,43,68,136,408,1e6]):gen.float(LEGACY_CLOSE_PX,5000);
 if(locked)return gen.bool(0.3)?gen.pick([-55,-8,-1,0,1,8,41]):gen.float(-LEGACY_OPEN_PX,LEGACY_CLOSE_PX);
 return gen.bool(0.3)?gen.pick([-55,-8,8,41]):gen.bool(0.5)?-gen.float(AXIS_DEADZONE_PX,LEGACY_OPEN_PX):gen.float(AXIS_DEADZONE_PX,LEGACY_CLOSE_PX);
}

/** A vertical displacement: anything when `free`, otherwise under 1/1.25 of `totalDx`, which resolveAxis then reads as horizontal from 8px. */
function legacyDy(gen,totalDx,free){
 if(free)return gen.bool(0.2)?0:gen.sign()*gen.float(0,10000);
 return gen.bool(0.25)?0:gen.sign()*gen.float(0,Math.abs(totalDx)/AXIS_BIAS_RATIO);
}

/** An offset the halfway rule resolves to `open`: from half the End_Stop out to the capped floor, or from short of half in to the clamp at 0. */
function halfwaySideOffset(gen,endStop,open){
 const half=endStop/2;   // exact, since halving changes only the exponent
 if(!open)return gen.bool(0.3)?0:half*gen.random();                                         // the clamp, or anywhere short of half
 if(gen.bool(0.5))return half*(1+gen.random());                                             // from half the End_Stop to the End_Stop
 return trackOffset(0,boundsDx(gen,gen.pick(RUBBER_RELEASE_REGIONS),0,endStop),endStop);   // into the rubber band or onto its floor
}

/** The offset a release holds, which this rule ignores: when `against`, on the side of the halfway point opposite `expected`, otherwise from any region of property 2. */
function legacyOffset(gen,endStop,expected,against){
 if(against)return halfwaySideOffset(gen,endStop,!expected);
 const {startOffset}=linearStart(gen,endStop);
 return trackOffset(startOffset,boundsDx(gen,gen.pick(BOUNDS_REGIONS),startOffset,endStop),endStop);
}

/** The End_Stop, prior state and offset of a null-velocity release. Half the time the prior state opposes the displacement wherever it decides, and the offset opposes the outcome, the rule's on a `horizontal` release axis and the prior state otherwise. */
function legacyInputs(gen,totalDx,horizontal){
 const {kind,endStop}=linearEndStop(gen);
 const verdict=legacyVerdict(totalDx),against=gen.bool(0.5);
 const wasOpen=against&&verdict!==null?!verdict:gen.bool();
 return {kind,against,offset:legacyOffset(gen,endStop,horizontal?(verdict??wasOpen):wasOpen,against),endStop,velocity:null,wasOpen};
}

/** A null-velocity release with a horizontal release axis: 70% from an unresolved lock read off the displacement, as a release with no move has it, the rest from a horizontal lock. */
function legacySample(gen){
 const axis=gen.bool(0.7)?null:'horizontal',band=gen.pick(['open','close','between']);
 const totalDx=legacyTotalDx(gen,band,axis!==null);
 return {band,...legacyInputs(gen,totalDx,true),totalDx,totalDy:legacyDy(gen,totalDx,axis!==null),axis};
}

/** A null-velocity release with a horizontal release axis, aimed exactly at a threshold or one double toward zero or away from it. */
function legacyEdgeSample(gen){
 const threshold=gen.pick([-LEGACY_OPEN_PX,LEGACY_CLOSE_PX]),edge=gen.pick(LEGACY_EDGES),axis=gen.bool(0.7)?null:'horizontal';
 const totalDx=edge==='on'?threshold:ulpStep(threshold,edge==='away'?1:-1);
 return {threshold,edge,...legacyInputs(gen,totalDx,true),totalDx,totalDy:legacyDy(gen,totalDx,axis!==null),axis};
}

/** A null-velocity release whose axis is not horizontal: locked vertical, or unresolved over a displacement resolveAxis reads as vertical, as the wedge, or as the dead zone. */
function offAxisSample(gen){
 const shape=gen.pick(['verticalLock','verticalLock','vertical','vertical','wedge','wedge','deadzone']);
 if(shape==='verticalLock'){
  const totalDx=legacyTotalDx(gen,gen.pick(['open','close','between']),true);
  return {shape,...legacyInputs(gen,totalDx,false),totalDx,totalDy:legacyDy(gen,totalDx,gen.bool(0.5)),axis:'vertical'};   // half the time under 1/1.25 of totalDx, as a horizontal drag would be
 }
 const deadzone=()=>gen.bool(0.25)?gen.pick([0,AXIS_DEADZONE_EXCLUSIVE]):gen.float(0,AXIS_DEADZONE_PX);
 const {ax,ay}=shape==='vertical'?resolvingPair(gen,'vertical'):shape==='wedge'?wedgePair(gen):{ax:deadzone(),ay:deadzone()};
 const totalDx=gen.sign()*ax;
 return {shape,...legacyInputs(gen,totalDx,false),totalDx,totalDy:gen.sign()*ay,axis:null};
}

forAll(LEGACY_DECIDES,
 gen=>legacySample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(endStop).toBeLessThan(0);                                 // a row with actions, so the inert-row exception is out of play
  expect(velocity).toBeNull();                                     // not measured, as for a release with no move
  expect(axis??resolveAxis(totalDx,totalDy)).toBe('horizontal');   // the release axis really is horizontal
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(legacyVerdict(totalDx)??wasOpen);   // open from 56px left (5.1), closed from 42px right (5.2), the prior state between
 });

forAll(LEGACY_INCLUSIVE,
 gen=>legacyEdgeSample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(velocity).toBeNull();
  expect(axis??resolveAxis(totalDx,totalDy)).toBe('horizontal');
  const open=resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen});
  expect(open).toBe(legacyVerdict(totalDx)??wasOpen);
  if(totalDx===-LEGACY_OPEN_PX)expect(open).toBe(true);                  // exactly 56px leftward opens: the boundary is inclusive
  if(totalDx===ulpStep(-LEGACY_OPEN_PX,-1))expect(open).toBe(wasOpen);   // and the next double toward zero keeps the prior state
  if(totalDx===LEGACY_CLOSE_PX)expect(open).toBe(false);                 // exactly 42px rightward closes
  if(totalDx===ulpStep(LEGACY_CLOSE_PX,-1))expect(open).toBe(wasOpen);   // and the next double toward zero keeps the prior state
 });

forAll(LEGACY_OFF_AXIS,
 gen=>offAxisSample(gen),
 ({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})=>{
  expect(velocity).toBeNull();
  expect(axis??resolveAxis(totalDx,totalDy)).not.toBe('horizontal');   // the release axis really is vertical or unresolved
  expect(resolveRelease({offset,endStop,velocity,totalDx,totalDy,axis,wasOpen})).toBe(wasOpen);   // the prior state, whatever the displacement
 });

test('the property 8 generators reach both lock states, every band and offset region, both thresholds and the doubles beside them, and releases with every other input against the outcome',()=>{
 const reached={unresolvedLock:0,horizontalLock:0,geometry:0,arbitrary:0,tiny:0,huge:0,open:0,close:0,between:0,clamped:0,linear:0,rubber:0,capped:0,
  openAgainstAll:0,closeAgainstAll:0,keptAgainstHalfway:0,lockAgainstDisplacement:0,
  onOpen:0,onClose:0,awayOpen:0,awayClose:0,insideOpenFromOpen:0,insideOpenFromClosed:0,insideCloseFromOpen:0,insideCloseFromClosed:0,
  verticalLock:0,vertical:0,wedge:0,deadzone:0,verticalLockAgainstDistance:0,verticalAgainstDistance:0,wedgeAgainstDistance:0,
  lockOverDisplacement:0,offAxisAgainstHalfway:0};
 // The region a rendered offset sits in: the clamp at 0, the linear zone, inside the rubber band, or on its 48px floor.
 const offsetRegion=(offset,endStop)=>offset===0?'clamped':offset>=endStop?'linear':offset>endStop-RUBBER_MAX_PX?'rubber':'capped';
 runAll(LEGACY_DECIDES,gen=>legacySample(gen),({kind,offset,endStop,totalDx,totalDy,axis,wasOpen})=>{
  const verdict=legacyVerdict(totalDx),halfway=halfwayOpen(offset,endStop);
  reached[axis===null?'unresolvedLock':'horizontalLock']+=1;
  reached[kind]+=1;
  reached[verdict===null?'between':verdict?'open':'close']+=1;
  reached[offsetRegion(offset,endStop)]+=1;
  if(axis===null){   // the shape of a real release with no move
   if(verdict===true&&!wasOpen&&!halfway)reached.openAgainstAll+=1;      // where keeping the prior state or the halfway rule would show
   if(verdict===false&&wasOpen&&halfway)reached.closeAgainstAll+=1;
   if(verdict===null&&halfway!==wasOpen)reached.keptAgainstHalfway+=1;   // where falling through to the halfway rule would show
  }else if(resolveAxis(totalDx,totalDy)!=='horizontal'&&verdict!==null&&verdict!==wasOpen)reached.lockAgainstDisplacement+=1;   // where reading the displacement over the lock would show
 });
 runAll(LEGACY_INCLUSIVE,gen=>legacyEdgeSample(gen),({totalDx,wasOpen})=>{
  if(totalDx===-LEGACY_OPEN_PX&&!wasOpen)reached.onOpen+=1;               // where `<` for `<=` would show
  if(totalDx===LEGACY_CLOSE_PX&&wasOpen)reached.onClose+=1;               // where `>` for `>=` would show
  if(totalDx===ulpStep(-LEGACY_OPEN_PX,1)&&!wasOpen)reached.awayOpen+=1;
  if(totalDx===ulpStep(LEGACY_CLOSE_PX,1)&&wasOpen)reached.awayClose+=1;
  if(totalDx===ulpStep(-LEGACY_OPEN_PX,-1))reached[wasOpen?'insideOpenFromOpen':'insideOpenFromClosed']+=1;    // where a threshold one double looser would show
  if(totalDx===ulpStep(LEGACY_CLOSE_PX,-1))reached[wasOpen?'insideCloseFromOpen':'insideCloseFromClosed']+=1;
 });
 runAll(LEGACY_OFF_AXIS,gen=>offAxisSample(gen),({shape,offset,endStop,totalDx,totalDy,axis,wasOpen})=>{
  const verdict=legacyVerdict(totalDx),againstDistance=verdict!==null&&verdict!==wasOpen;   // where falling through to the distance rule would show
  reached[shape]+=1;
  if(againstDistance)reached[shape+'AgainstDistance']+=1;
  if(axis==='vertical'&&resolveAxis(totalDx,totalDy)==='horizontal'&&againstDistance)reached.lockOverDisplacement+=1;   // where reading the displacement over the lock would show
  if(halfwayOpen(offset,endStop)!==wasOpen)reached.offAxisAgainstHalfway+=1;   // where falling through to the halfway rule would show
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything a generator missed
 for(const threshold of [-LEGACY_OPEN_PX,LEGACY_CLOSE_PX]){
  const inside=ulpStep(threshold,-1),away=ulpStep(threshold,1);
  expect(Math.abs(inside)).toBeLessThan(Math.abs(threshold));
  expect(Math.abs(away)).toBeGreaterThan(Math.abs(threshold));
  expect([inside,threshold]).toContain((inside+threshold)/2);   // each midpoint rounds onto an end, so no double
  expect([threshold,away]).toContain((threshold+away)/2);       // lies between a threshold and either neighbour
 }
});

test('the tests/app.e2e.js swipe opens a real two-action row by the distance rule, and the same release measured at 0 stays closed',()=>{
 const endStop=-2*ACTION_WIDTH_PX;   // -136, the End_Stop of the first activity card, with edit and delete
 // pointerdown, then pointerup 85px to the left on the same line, with no move between: nothing was tracked, so the offset is still the closed start and the lock never resolved.
 const release=velocity=>resolveRelease({offset:0,endStop,velocity,totalDx:-85,totalDy:0,axis:null,wasOpen:false});
 expect(release(null)).toBe(true);    // not measured: the displacement reads horizontal, and 85px clears the 56px rule (5.1)
 expect(release(0)).toBe(false);      // measured as still: the halfway rule decides, and an offset of 0 is under 68px
 expect(resolveRelease({offset:0,endStop:0,velocity:null,totalDx:-85,totalDy:0,axis:null,wasOpen:true})).toBe(false);   // a row with no actions stays closed, though the rule and the prior state both say open
});
// ---------------------------------------------------------------------------
// Property 10: A gesture suppresses a click only after real travel
// **Validates: Requirements 2.9**
//
// The contract: for any axis state and any horizontal displacement,
// `shouldSuppressClick` returns true if and only if the axis lock resolved to
// horizontal or the displacement magnitude is at least 42px. A tap has
// neither, so it never suppresses. The distance clause is criterion 2.9. The
// axis clause covers a fast short flick, which changes the row's state over
// less than 42px and must not also fire a click; the old 42px-only rule let
// that click through. The expected value is the disjunction itself, computed
// from the test's own constants. The 42px of 2.9 equals the 42px of 5.2 but
// belongs to a separate requirement, so it gets its own name instead of
// `LEGACY_CLOSE_PX`.
//
// The axis is drawn from the three states a gesture record can hold:
// horizontal, vertical, and `null` for unresolved. The displacement is drawn
// in both signs: none, inside the 8px dead zone, from 8px to 42px, one double
// short of 42px, exactly 42px, a real drag, and huge, up to the largest double.
// The samples are weighted toward the cases where the clauses disagree or
// neither holds: a horizontal lock under 42px, which only the axis clause
// suppresses; a vertical or unresolved lock from 42px, which only the distance
// clause suppresses; and a vertical or unresolved lock under 42px, which
// nothing suppresses. Each is drawn twice as often as a horizontal lock from
// 42px, where both clauses hold and most breakages would still return true.
//
// The boundary and the tap get tests of their own, which enumerate their
// inputs because there are only a handful. 42 is an exact double and negation
// is exact, so the thresholds are exactly -42 and 42, and `ulpStep` gives the
// next double toward zero from each. The tap test covers a displacement of 0
// and of -0 against both locks that are not horizontal. A real tap holds the
// unresolved one, because a horizontal lock needs 8px of horizontal travel
// (property 4).
// ---------------------------------------------------------------------------

/** The property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const CLICK_SUPPRESSION='property 10: a gesture suppresses the click that follows if and only if its axis locked horizontal or it travelled at least 42px either way';
/** The click-suppression distance of requirement 2.9. */
const CLICK_SUPPRESS_PX=42;
/** The axis states other than a horizontal lock: a vertical lock, and unresolved. */
const NOT_HORIZONTAL=['vertical',null];
/** Each case where the clauses disagree or neither holds, twice, and the case where both hold, once. */
const CLICK_CASES=['axis-only','axis-only','distance-only','distance-only','neither','neither','both'];

/** A travel magnitude under 42px: none, inside the dead zone, from 8px, or one double short. When `far`, at least 42px: exactly, a real drag, or huge. */
function clickTravel(gen,far){
 const band=gen.pick(far?['at','at','long','long','huge']:['zero','deadzone','deadzone','short','short','under']);
 if(band==='zero')return 0;
 if(band==='deadzone')return gen.bool(0.3)?gen.pick([0.5,1,4,7,AXIS_DEADZONE_EXCLUSIVE]):gen.float(0,AXIS_DEADZONE_PX);
 if(band==='short')return gen.bool(0.3)?gen.pick([AXIS_DEADZONE_PX,10,20,30,41]):gen.float(AXIS_DEADZONE_PX,CLICK_SUPPRESS_PX);
 if(band==='under')return ulpStep(CLICK_SUPPRESS_PX,-1);
 if(band==='at')return CLICK_SUPPRESS_PX;
 if(band==='long')return gen.bool(0.3)?gen.pick([ulpStep(CLICK_SUPPRESS_PX,1),43,56,85,136,390]):gen.float(CLICK_SUPPRESS_PX,5000);
 return gen.bool(0.3)?gen.pick([1e6,1e9,Number.MAX_VALUE]):gen.float(5000,1e6);
}

/** One case of CLICK_CASES: an axis state and a travel in either direction. JSON prints -0 as 0, so `sign` says which zero a sample holds. */
function clickSample(gen){
 const kind=gen.pick(CLICK_CASES),sign=gen.sign();   // -1 leftward, +1 rightward
 const axis=kind==='axis-only'||kind==='both'?'horizontal':gen.pick(NOT_HORIZONTAL);
 return {kind,axis,sign,totalDx:sign*clickTravel(gen,kind==='distance-only'||kind==='both')};
}

forAll(CLICK_SUPPRESSION,
 gen=>clickSample(gen),
 ({axis,totalDx})=>{
  expect(shouldSuppressClick(axis,totalDx)).toBe(axis==='horizontal'||Math.abs(totalDx)>=CLICK_SUPPRESS_PX);   // a horizontal lock, or 42px of travel either way (2.9)
 });

test('the property 10 generator reaches every axis state and travel band, and each clause alone, neither, and both',()=>{
 const reached={horizontal:0,vertical:0,unresolved:0,zero:0,deadzone:0,short:0,under:0,at:0,long:0,huge:0,
  axisOnly:0,distanceOnlyLeft:0,distanceOnlyRight:0,neitherVertical:0,neitherUnresolved:0,both:0,offAxisAt:0};
 const under=ulpStep(CLICK_SUPPRESS_PX,-1);
 runAll(CLICK_SUPPRESSION,gen=>clickSample(gen),({axis,totalDx})=>{
  const travel=Math.abs(totalDx),horizontal=axis==='horizontal',far=travel>=CLICK_SUPPRESS_PX;
  reached[axis??'unresolved']+=1;
  reached[travel===0?'zero':travel<AXIS_DEADZONE_PX?'deadzone':travel===under?'under':!far?'short':travel===CLICK_SUPPRESS_PX?'at':travel<5000?'long':'huge']+=1;
  if(horizontal)reached[far?'both':'axisOnly']+=1;                            // under 42px, where dropping the axis clause or `&&` for `||` would show
  else if(far)reached[totalDx<0?'distanceOnlyLeft':'distanceOnlyRight']+=1;   // where `&&` would show, and leftward where dropping Math.abs would
  else reached[axis===null?'neitherUnresolved':'neitherVertical']+=1;         // where a looser axis test or a lower threshold would show
  if(!horizontal&&travel===CLICK_SUPPRESS_PX)reached.offAxisAt+=1;           // where `>` for `>=` would show
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything the generator missed
});

test('exactly 42px of travel either way suppresses the click and one double toward zero does not, when the lock is not horizontal',()=>{
 for(const threshold of [-CLICK_SUPPRESS_PX,CLICK_SUPPRESS_PX]){
  const inside=ulpStep(threshold,-1);                           // the next double toward zero
  expect(Math.abs(inside)).toBeLessThan(CLICK_SUPPRESS_PX);
  expect([inside,threshold]).toContain((inside+threshold)/2);   // the midpoint rounds onto an end, so no double lies between them
  for(const axis of NOT_HORIZONTAL){
   expect(shouldSuppressClick(axis,threshold)).toBe(true);      // exactly 42px suppresses: the boundary is inclusive
   expect(shouldSuppressClick(axis,inside)).toBe(false);        // one double short of it does not
  }
 }
});

test('a tap, with no horizontal travel and no horizontal lock, leaves the click alone',()=>{
 for(const axis of NOT_HORIZONTAL)for(const totalDx of [0,-0])expect(shouldSuppressClick(axis,totalDx)).toBe(false);
});

test('the tests/app.e2e.js swipe and a 20px flick suppress the click that follows, and a tap and a vertical scroll do not',()=>{
 expect(shouldSuppressClick(null,-85)).toBe(true);          // pointerdown, then pointerup 85px left with no move between: no lock, but 85px clears 42px
 expect(shouldSuppressClick('horizontal',-20)).toBe(true);  // a 20px flick opens the row (property 6); the old 42px-only rule let its click through
 expect(shouldSuppressClick(null,0)).toBe(false);           // a tap: no move, so no lock, and no travel
 expect(shouldSuppressClick('vertical',0)).toBe(false);     // a 30px vertical scroll with no horizontal travel, which locks vertical
});
// ---------------------------------------------------------------------------
// The frame writer: one write per rendered frame
// **Validates: Requirements 1.8**
//
// The contract: `createFrameWriter(write, raf, caf)` holds at most one value.
// `push` stores its value over any earlier one and calls `raf` only when no
// frame is scheduled yet, so that frame writes the newest value, once.
// `cancel` drops the value and hands the scheduled frame's handle to `caf`.
// `flushTarget` cancels, then writes its own value on the spot. A burst of
// pointer events between two frames therefore costs one `raf` call and one
// `write`. No end-to-end test can observe this, because the page renders the
// same translation whether `--swipe-x` was set once in a frame or eight
// times, so these tests are the only check of criterion 1.8.
//
// A fake scheduler stands in for the browser and runs no frame until a test
// calls `run()`. As in a browser, a frame runs the callbacks queued before it
// began, so a callback queued during a frame waits for the next one.
//
// One case needs care. A browser never runs a cancelled callback, but one
// test models a browser that ignores `caf` and runs it anyway. The callback
// does not check that it is still the scheduled one, so it still calls
// `write`, with the `null` that `cancel` left in `pending`. What the reset
// does guarantee, and what that test asserts, is that the cancelled value
// never reaches `write`.
//
// The property drives random runs of `push`, `frame`, `cancel` and
// `flushTarget` against a reference model that has no scheduler, and compares
// after every step: the `write` log, the `raf` calls against the frames the
// model scheduled, and the `caf` calls against the frames it cancelled.
// Comparing after each step rather than only at the end also checks timing:
// `push` never writes on the spot, and `flushTarget` always does.
// ---------------------------------------------------------------------------

/** The property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const FRAME_WRITER_MODEL='frame writer: over any run of pushes, frames, cancels and flushes it writes what a reference model writes, at the same steps, and never twice in one frame';
/** The operations a run can hold, weighted toward `push` so that bursts of several moves inside one frame are common. */
const WRITER_OPS=['push','push','push','push','push','frame','frame','cancel','flushTarget'];

/** A fake requestAnimationFrame/cancelAnimationFrame pair that records every call and runs no frame until `run()`. With `ignoreCancel` it records each `caf` call but leaves the callback queued, like a browser that ignores `caf`. */
function fakeFrames({ignoreCancel=false}={}){
 const queue=new Map(),rafCalls=[],cafCalls=[];
 // Handles are positive integers that only grow, as a browser's are. The writer reads `if(handle)` to tell whether a frame
 // is scheduled, so a fake that returned 0 would make every push schedule another frame and defeat the coalescing.
 let last=0;
 return {rafCalls,cafCalls,
  raf(callback){last+=1;queue.set(last,callback);rafCalls.push(last);return last;},
  caf(handle){cafCalls.push(handle);if(!ignoreCancel)queue.delete(handle);},
  queued(){return [...queue.keys()];},
  run(){   // one frame; returns how many callbacks ran
   let ran=0;
   for(const handle of [...queue.keys()]){   // the snapshot taken as the frame begins
    const callback=queue.get(handle);
    if(!callback)continue;                   // cancelled by an earlier callback in this frame
    queue.delete(handle);callback();ran+=1;
   }
   return ran;
  }};
}

/** The reference model, the contract with no scheduler in it: at most one value waits, the next frame writes it once, a push replaces it, `cancel` drops it, and `flushTarget` drops it and writes its own value at once. A frame counts as scheduled when a value starts waiting and as cancelled when a waiting value is dropped. */
function writerModel(){
 return {waiting:false,value:undefined,writes:[],scheduled:0,cancelled:0,
  push(value){if(!this.waiting)this.scheduled+=1;this.waiting=true;this.value=value;},
  cancel(){if(this.waiting)this.cancelled+=1;this.waiting=false;},
  flushTarget(value){this.cancel();this.writes.push(value);},
  frame(){if(this.waiting)this.writes.push(this.value);this.waiting=false;}};
}

/** A run of 1 to 40 operations on one writer, with offsets a two-action row can render and the odd repeat of the last one. */
function writerOps(gen){
 const ops=[];
 let last=0;
 for(let i=0,count=gen.int(1,40);i<count;i+=1){
  const op=gen.pick(WRITER_OPS);
  if(op==='frame'||op==='cancel'){ops.push({op});continue;}
  last=gen.bool(0.15)?last:gen.bool(0.2)?gen.pick([0,-68,-136,-184]):-gen.float(0,184);   // the same offset again, closed, halfway, the End_Stop or the floor, or any
  ops.push({op,value:last});
 }
 return {ops};
}

forAll(FRAME_WRITER_MODEL,
 gen=>writerOps(gen),
 ({ops})=>{
  const frames=fakeFrames(),writes=[],model=writerModel();
  const writer=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
  for(const {op,value} of ops){
   const before=writes.length;
   if(op==='frame'){frames.run();expect(writes.length-before).toBeLessThanOrEqual(1);}   // no frame ever writes twice
   else writer[op](value);
   model[op](value);
   expect(writes).toEqual(model.writes);                   // the same values in the same order, each at the step the model writes it
   expect(frames.rafCalls.length).toBe(model.scheduled);   // one raf call per frame the model scheduled
   expect(frames.cafCalls.length).toBe(model.cancelled);   // and one caf call per frame it cancelled
  }
 });

test('frame writer: the generator reaches long bursts, a second writing frame, a frame after a dropped value, cancels and flushes with a frame pending and with none, idle frames, and repeats',()=>{
 const reached={burst:0,longBurst:0,secondFrame:0,afterDrop:0,cancelPending:0,cancelIdle:0,flushTargetPending:0,flushTargetIdle:0,idleFrame:0,repeat:0};
 runAll(FRAME_WRITER_MODEL,gen=>writerOps(gen),({ops})=>{
  const model=writerModel();
  let burst=0,written=0,dropped=false,last;
  for(const {op,value} of ops){
   if(op==='push'){burst=model.waiting?burst+1:1;if(value===last)reached.repeat+=1;}
   if(op==='cancel'||op==='flushTarget'){reached[op+(model.waiting?'Pending':'Idle')]+=1;if(model.waiting)dropped=true;}
   if(op==='frame'&&!model.waiting)reached.idleFrame+=1;
   if(op==='frame'&&model.waiting){
    written+=1;
    if(burst>=2)reached.burst+=1;           // where a write on every push would show
    if(burst>=5)reached.longBurst+=1;
    if(written>=2)reached.secondFrame+=1;   // where a handle left set after a frame would show
    if(dropped)reached.afterDrop+=1;        // where a handle left set after a cancel would show
   }
   if(value!==undefined)last=value;
   model[op](value);
  }
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything the generator missed
});

test('frame writer: many pushes before a frame write nothing until the frame runs, then write once with the newest value, from one raf call',()=>{
 const frames=fakeFrames(),writes=[];
 const writer=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
 for(const value of [-20,-24,-28,-31,-33,-32,-30,-27])writer.push(value);   // eight moves in one frame, turning back, so the newest is neither the first nor the furthest
 expect(writes).toEqual([]);              // nothing is written between frames
 expect(frames.rafCalls).toEqual([1]);    // only the first push scheduled a frame
 expect(frames.run()).toBe(1);
 expect(writes).toEqual([-27]);           // one write, carrying the newest value
 expect(frames.run()).toBe(0);            // and the frame after it has nothing to do
 expect(writes).toEqual([-27]);
 expect(frames.cafCalls).toEqual([]);
});

test('frame writer: a push after the frame ran schedules a new frame, and the next burst writes once with its own newest value',()=>{
 const frames=fakeFrames(),writes=[];
 const writer=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
 writer.push(-10);writer.push(-20);frames.run();
 for(const value of [-30,-40,-50])writer.push(value);
 expect(frames.rafCalls).toEqual([1,2]);   // the first push after the frame scheduled a fresh one, and only that push did
 expect(writes).toEqual([-20]);
 expect(frames.run()).toBe(1);
 expect(writes).toEqual([-20,-50]);
});

test('frame writer: cancel drops the pending write by handing its frame to caf, and calls no caf when nothing is pending',()=>{
 const frames=fakeFrames(),writes=[];
 const writer=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
 writer.cancel();
 expect(frames.cafCalls).toEqual([]);       // nothing scheduled yet, so nothing to cancel
 writer.push(-20);frames.run();
 writer.cancel();
 expect(frames.cafCalls).toEqual([]);       // nor once the frame has run
 writer.push(-40);writer.push(-68);         // frame 2 is pending
 writer.cancel();
 expect(frames.cafCalls).toEqual([2]);      // the pending frame's own handle
 expect(frames.run()).toBe(0);
 expect(writes).toEqual([-20]);             // so -68 is never written
 writer.cancel();
 expect(frames.cafCalls).toEqual([2]);      // a second cancel finds nothing left to cancel
 writer.push(-12);frames.run();
 expect(frames.rafCalls).toEqual([1,2,3]);  // and a push after a cancel schedules a fresh frame
 expect(writes).toEqual([-20,-12]);
});

test('frame writer: a cancelled frame that a browser runs anyway never writes the cancelled value',()=>{
 const frames=fakeFrames({ignoreCancel:true}),writes=[];
 const writer=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
 writer.push(-40);writer.push(-68);
 writer.cancel();
 expect(frames.cafCalls).toEqual([1]);
 expect(frames.run()).toBe(1);              // the fake ran the cancelled callback regardless
 // The callback calls write with the null that cancel left in `pending`, as the note above explains. Only the cancelled values are ruled out.
 expect(writes.filter(value=>value!==null)).toEqual([]);
});

test('frame writer: flushTarget writes at once, before any frame, and cancels a pending frame so its value is never written',()=>{
 const frames=fakeFrames(),writes=[];
 const writer=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
 writer.flushTarget(-136);
 expect(writes).toEqual([-136]);            // synchronous: no frame has run
 expect(frames.rafCalls).toEqual([]);       // and none was scheduled for it
 expect(frames.cafCalls).toEqual([]);       // nothing was pending, so nothing was cancelled
 writer.push(-20);writer.push(-30);
 writer.flushTarget(0);
 expect(writes).toEqual([-136,0]);
 expect(frames.cafCalls).toEqual([1]);      // the pending frame was cancelled
 expect(frames.run()).toBe(0);
 expect(writes).toEqual([-136,0]);          // so -30 is never written after the flush
});

test('frame writer: push, flushTarget and cancel behave the same when destructured off the writer',()=>{
 const frames=fakeFrames(),writes=[];
 const {push,flushTarget,cancel}=createFrameWriter(value=>writes.push(value),frames.raf,frames.caf);
 push(-5);push(-15);frames.run();           // coalesced into one write of -15
 push(-25);cancel();frames.run();           // dropped
 push(-35);flushTarget(-136);frames.run();  // written at once, and the pending -35 dropped
 expect(writes).toEqual([-15,-136]);
 expect(frames.rafCalls).toEqual([1,2,3]);
 expect(frames.cafCalls).toEqual([2,3]);
});

test('frame writer: a write that pushes again schedules a fresh frame instead of being swallowed',()=>{
 const frames=fakeFrames(),writes=[];
 const writer=createFrameWriter(value=>{writes.push(value);if(writes.length===1)writer.push(-20);},frames.raf,frames.caf);
 writer.push(-10);
 expect(frames.run()).toBe(1);
 expect(writes).toEqual([-10]);
 expect(frames.rafCalls).toEqual([1,2]);    // the push inside write scheduled frame 2, because the handle was cleared before write ran
 expect(frames.queued()).toEqual([2]);      // and frame 2 waits for the next frame, as a browser defers it
 expect(frames.run()).toBe(1);
 expect(writes).toEqual([-10,-20]);
});
// ---------------------------------------------------------------------------
// Property 11: The release velocity covers the 100ms that end at the release
// **Validates: Requirements 2.1, 2.2, 2.11, 5.1, 5.2**
//
// The contract: for any trace of moves and any release no earlier than the
// last move, `releaseVelocity` returns `null`, the not-measured value, if and
// only if the trace is empty. Otherwise it returns the slope from the earliest
// move at most 100ms before the release instant to the release, or 0 when no
// move falls there or every move that does shares the release's timestamp.
// `releaseOracle` computes the expected value by a forward search, without
// `sampleVelocity`. It encodes the same rule as `measuredReleaseVelocity` in
// `tests/mobile-swipe.e2e.js`.
//
// Traces come from property 5's `velocityTrace`, on its three clocks. The
// release comes on the last move's tick, under a frame after it, about a
// frame after, tens of milliseconds after, exactly 100ms after, one
// representable step past that, or after a pause well past the window. A
// release that waits is read off the trace's clock, so on the 1ms clock a
// wait under a millisecond lands on the last move's tick. The two edge
// releases are built from the last move's time instead, the way property 5
// pins its edges: the latest release still within 100ms, and the next double
// after it. The first is exactly 100ms after the move wherever `t + 100` is a
// double. On the finer clocks the sum can round where it crosses a power of
// two, and there the latest release inside is a hair under 100ms. Three
// releases in four sit at the last move's x, as a real `pointerup` does, and
// the rest up to 60px away. Half the traces with moves also get a move pinned
// exactly 100ms before the release or one step earlier, by property 5's
// `pinWindowEdge` run over the trace with the release appended, so the edge
// also falls among earlier moves.
//
// Every comparison is exact. Along a trace in time order `release.t - s.t`
// never increases, so the moves inside the window form a suffix of the trace.
// The implementation walks back from the appended release and the oracle
// searches forward, so both stop at the same oldest move, or both find none
// and return 0. Each then divides the same two differences of the same
// doubles.
//
// The second property checks requirement 2.11. Before task 4.5 the release
// path measured the window back from the last move, so a fast drag that
// paused before the lift still measured as a flick. The property draws drags
// of at least 1px/ms with moves 8 to 17.7ms apart, which property 5's
// `velocityOracle` measures, as the old rule did, at more than twice the
// Flick_Threshold on every clock: the 1ms clock can stretch an 8ms span to
// just under 9ms, which still leaves more than 0.88px/ms. It releases each
// drag one step past the window or up to 2s after the last move, and each
// must measure exactly 0. `null` there would hand the release to the
// 56px/42px rule instead of the halfway rule.
//
// The third property keeps `null` the hinge of the legacy path: only a
// gesture with no move reaches the 56px/42px rule (5.1, 5.2). It takes
// property 5's `collapsedSample` traces, which `sampleVelocity` cannot
// measure on their own: no move, one move, or a window collapsed onto one
// instant. Released on the last move's tick or whole milliseconds later, each
// one with a move must measure a number, and the empty one `null`.
// ---------------------------------------------------------------------------

/** Each property's name, shared with the generator self-check below so it replays exactly the samples the property saw. */
const RELEASE_WINDOW='property 11: releaseVelocity is the slope from the earliest move in the 100ms before the release to the release, 0 when none falls there, and null only with no move';
const RELEASE_PAUSE='property 11: a fast drag released more than 100ms after its last move measures exactly 0, where the old rule measured a flick';
const RELEASE_NULL_ONLY_EMPTY='property 11: releaseVelocity is null for a trace with no move and a number for every other trace sampleVelocity cannot measure on its own';
/** The time from the last move to the release: none, under a frame, about a frame, tens of ms, on the window's edge, one step past it, or a pause. */
const RELEASE_GAPS=['same','same','sub-frame','frame','tens','at-window','past-window','pause'];

/** The oracle: the slope from the earliest move at most 100ms before the release to the release, 0 when none is or the window has no width, and null with no move. */
function releaseOracle(trace,release){
 if(!trace?.length)return null;
 const first=trace.find(sample=>inVelocityWindow(release,sample)),dt=first?release.t-first.t:0;
 return dt>0?(release.x-first.x)/dt:0;
}

/** The latest release still within 100ms of a move at `t`: `t + 100` wherever that sum is a double, else the double just below it. The next double up is the earliest release past the window. */
function windowEdgeRelease(t){const at=t+VELOCITY_WINDOW_MS;return at-t<=VELOCITY_WINDOW_MS?at:ulpStep(at,-1);}

/** When the release comes, `gap` after the last move: on its tick, after a wait read off the trace's clock, or either side of the window's edge. */
function releaseTime(gen,gap,last,clock){
 if(gap==='same')return last.t;
 if(gap==='at-window')return windowEdgeRelease(last.t);
 if(gap==='past-window')return ulpStep(windowEdgeRelease(last.t),1);
 const wait=gap==='sub-frame'?(gen.bool(0.3)?gen.float(0.01,1):gen.float(1,16.7)):gap==='frame'?FRAME_MS+gen.float(-1,1):gap==='tens'?gen.float(20,99):gen.float(VELOCITY_WINDOW_MS+1,2000);
 return VELOCITY_CLOCKS[clock](last.t+wait);
}

/** A release at time `t`: at the last move's x three times in four, as a real `pointerup` is, otherwise up to 60px away. */
function releaseAt(gen,last,t){return {x:gen.bool(0.75)?last.x:last.x+gen.float(-60,60),t};}

/** A property 5 trace with a release appended and, half the time, a move pinned on the release's window edge. */
function releaseSample(gen){
 const {clock,drift,trace}=velocityTrace(gen,gen.bool(0.4)?gen.pick([0,1,1,2,3]):gen.int(4,30)),last=trace[trace.length-1];
 if(!last)return {clock,drift,gap:'none',edge:'none',trace,release:{x:gen.float(0,390),t:VELOCITY_CLOCKS[clock](velocityOrigin(gen))}};
 const gap=gen.pick(RELEASE_GAPS),edge=gen.pick(['none','none','at-window','past-window']);
 const all=[...trace,releaseAt(gen,last,releaseTime(gen,gap,last,clock))];
 if(edge!=='none')pinWindowEdge(gen,all,edge);   // pinned against the release, the last entry of `all`, which stays last
 return {clock,drift,gap,edge,trace:all.slice(0,-1),release:all[all.length-1]};
}

forAll(RELEASE_WINDOW,
 gen=>releaseSample(gen),
 ({trace,release})=>{
  expect(nonDecreasing([...trace,release])).toBe(true);   // moves in time order and a release no earlier than the last, as the tracker records them
  const velocity=releaseVelocity(trace,release);
  expect(velocity).toBe(releaseOracle(trace,release));    // exactly the oracle's value, the same double
  expect(velocity===null).toBe(trace.length===0);         // not measured only with no move (5.1, 5.2)
 });

/** A fast drag one way: at least 1px/ms over moves 8 to 17.7ms apart, on any clock. */
function fastTrace(gen){
 const clock=gen.pick(Object.keys(VELOCITY_CLOCKS)),direction=gen.sign();   // -1 leftward, +1 rightward
 let now=velocityOrigin(gen),x=gen.float(0,390);
 const trace=[{x,t:VELOCITY_CLOCKS[clock](now)}];
 for(let i=0,moves=gen.int(1,7);i<moves;i+=1){
  const step=gen.float(8,FRAME_MS+1);
  now+=step;x+=direction*gen.float(1,6)*step;
  trace.push({x,t:VELOCITY_CLOCKS[clock](now)});
 }
 return {clock,direction,trace};
}

/** A fast drag released one step past the window or after a longer pause. */
function pauseSample(gen){
 const {clock,direction,trace}=fastTrace(gen),last=trace[trace.length-1],gap=gen.pick(['past-window','pause','pause']);
 return {clock,direction,gap,trace,release:releaseAt(gen,last,releaseTime(gen,gap,last,clock))};
}

forAll(RELEASE_PAUSE,
 gen=>pauseSample(gen),
 ({direction,trace,release})=>{
  const old=velocityOracle(trace);   // what the old rule measured, back from the last move
  expect(release.t-trace[trace.length-1].t).toBeGreaterThan(VELOCITY_WINDOW_MS);   // the finger really stayed still past the window
  expect(Math.sign(old)).toBe(direction);
  expect(Math.abs(old)).toBeGreaterThanOrEqual(FLICK_THRESHOLD_PX_MS);   // a flick, which settled the row by its direction
  expect(releaseVelocity(trace,release)).toBe(0);                         // 2.11: exactly 0, not null, so the Drag_Offset decides
 });

/** One of property 5's traces that `sampleVelocity` cannot measure, released on its last move's tick or whole milliseconds later, to well past the window. */
function unmeasuredSample(gen){
 const {kind,trace}=collapsedSample(gen),last=trace[trace.length-1],wait=gen.pick([0,0,0,1,16,17,50,99,100,101,250,1000]);
 return {kind,wait,trace,release:last?releaseAt(gen,last,last.t+wait):{x:gen.float(0,390),t:velocityOrigin(gen)}};
}

forAll(RELEASE_NULL_ONLY_EMPTY,
 gen=>unmeasuredSample(gen),
 ({trace,release})=>{
  expect(velocityOracle(trace)).toBeNull();                       // the trace alone has no rate to measure
  const velocity=releaseVelocity(trace,release);
  if(trace.length)expect(Number.isFinite(velocity)).toBe(true);   // a move was sampled, so the release is measured: a number, never null
  else expect(velocity).toBeNull();                               // no move: the 56px/42px rule decides (5.1, 5.2)
  expect(velocity).toBe(releaseOracle(trace,release));
 });

test('the property 11 generators reach every clock, release gap and window edge, every outcome, fast pauses both ways, and every unmeasured trace',()=>{
 const reached={fine:0,'0.1ms':0,'1ms':0,empty:0,single:0,sameTick:0,underFrame:0,aboutFrame:0,tens:0,atWindow:0,hairPastWindow:0,pause:0,
  edgeAmongMoves:0,hairPastAmongMoves:0,releaseAtLastX:0,releaseElsewhere:0,noMoveInWindow:0,collapsedOnRelease:0,stationary:0,leftward:0,rightward:0,
  oldRuleUnmeasured:0,flickKept:0,flickLowered:0,'pause fine':0,'pause 0.1ms':0,'pause 1ms':0,pauseLeftward:0,pauseRightward:0,pauseByStep:0,pauseLong:0,
  'unmeasured empty':0,'unmeasured single':0,'unmeasured one-instant':0,'unmeasured older-then-single':0,'unmeasured older-then-one-instant':0,
  unmeasuredZero:0,unmeasuredSlope:0};
 const hairPast=age=>age>VELOCITY_WINDOW_MS&&age<=VELOCITY_WINDOW_MS+1e-6;
 const flick=velocity=>velocity!==null&&Math.abs(velocity)>=FLICK_THRESHOLD_PX_MS;
 // Classified by the oracles, never by releaseVelocity, so this test checks only what the generators reach.
 runAll(RELEASE_WINDOW,gen=>releaseSample(gen),({clock,trace,release})=>{
  reached[clock]+=1;
  if(!trace.length){reached.empty+=1;return;}
  if(trace.length===1)reached.single+=1;
  const last=trace[trace.length-1],gap=release.t-last.t,first=trace.find(sample=>inVelocityWindow(release,sample)),expected=releaseOracle(trace,release);
  reached[gap===0?'sameTick':gap<FRAME_MS-1?'underFrame':gap<=FRAME_MS+1?'aboutFrame':gap<VELOCITY_WINDOW_MS?'tens':gap===VELOCITY_WINDOW_MS?'atWindow':hairPast(gap)?'hairPastWindow':'pause']+=1;
  if(gap<VELOCITY_WINDOW_MS&&trace.some(sample=>release.t-sample.t===VELOCITY_WINDOW_MS))reached.edgeAmongMoves+=1;   // the oldest move used, with later ones beside it
  if(gap<VELOCITY_WINDOW_MS&&trace.some(sample=>hairPast(release.t-sample.t)))reached.hairPastAmongMoves+=1;         // dropped, while later ones are used
  reached[release.x===last.x?'releaseAtLastX':'releaseElsewhere']+=1;
  reached[!first?'noMoveInWindow':first.t===release.t?'collapsedOnRelease':expected===0?'stationary':expected<0?'leftward':'rightward']+=1;
  const old=velocityOracle(trace);
  if(old===null)reached.oldRuleUnmeasured+=1;                                // where returning the old rule's null would show
  else if(flick(old))reached[flick(expected)?'flickKept':'flickLowered']+=1;   // and where ignoring the release would
 });
 let slowestOldFlick=Infinity;
 runAll(RELEASE_PAUSE,gen=>pauseSample(gen),({clock,direction,trace,release})=>{
  reached['pause '+clock]+=1;
  reached[direction<0?'pauseLeftward':'pauseRightward']+=1;
  reached[hairPast(release.t-trace[trace.length-1].t)?'pauseByStep':'pauseLong']+=1;
  slowestOldFlick=Math.min(slowestOldFlick,Math.abs(velocityOracle(trace)));
 });
 runAll(RELEASE_NULL_ONLY_EMPTY,gen=>unmeasuredSample(gen),({kind,trace,release})=>{
  reached['unmeasured '+kind]+=1;
  if(trace.length)reached[releaseOracle(trace,release)===0?'unmeasuredZero':'unmeasuredSlope']+=1;
 });
 expect(Object.keys(reached).filter(name=>reached[name]===0)).toEqual([]);   // names anything a generator missed
 expect(slowestOldFlick).toBeGreaterThan(2*FLICK_THRESHOLD_PX_MS);          // every pause follows a drag the old rule measured at well over the threshold
});

test('releaseVelocity is null with no move, the tests/app.e2e.js gesture, and pairs one move with the release: 0 on its tick, their slope within 100ms, 0 past it',()=>{
 const lift={x:115,t:5000};
 expect(releaseVelocity([],lift)).toBeNull();               // pointerdown, then pointerup 85px left with no move: the 56px/42px rule decides (5.1, 5.2)
 expect(releaseVelocity(null,lift)).toBeNull();
 expect(releaseVelocity(undefined,lift)).toBeNull();
 const move=[{x:180,t:5000}];
 expect(releaseVelocity(move,{x:180,t:5000})).toBe(0);      // released on the move's own timestamp: a still finger, whether or not the clock ticked
 expect(releaseVelocity(move,{x:160,t:5000})).toBe(0);      // the window has no width, so even a release 20px away measures 0
 expect(releaseVelocity(move,{x:160,t:5050})).toBe(-0.4);   // 50ms later the move and the release form the pair: -20px over 50ms
 expect(releaseVelocity(move,{x:160,t:5100})).toBe(-0.2);   // exactly 100ms later the move is still inside the window
 expect(releaseVelocity(move,{x:160,t:5101})).toBe(0);      // 101ms later it is not, so the release measures 0, not null
});

test('a fast 40px drag over three frames flicks when released straight after its last move, and measures 0 after a 200ms pause',()=>{
 const drag=[{x:187,t:5016},{x:173,t:5032},{x:160,t:5048}];   // pointerdown at x 200 and t 5000, then 40px left in three moves a 16ms frame apart, as task 4.5 drove it in a browser
 expect(releaseVelocity(drag,{x:160,t:5048})).toBe(-27/32);    // released on the last move's tick: -27px from the first move over 32ms
 expect(releaseVelocity(drag,{x:160,t:5049})).toBe(-27/33);    // a millisecond later the same 27px spread over 33ms, a little slower
 expect(releaseVelocity(drag,{x:160,t:5049})).toBeLessThanOrEqual(-FLICK_THRESHOLD_PX_MS);   // still a leftward flick
 expect(releaseVelocity(drag,{x:160,t:5248})).toBe(0);         // after a 200ms pause: exactly 0, not null (2.11)
 expect(sampleVelocity(drag)).toBe(-27/32);                    // the old rule measured back from the last move, so the pause changed nothing
 const settle=velocity=>resolveRelease({offset:-40,endStop:-2*ACTION_WIDTH_PX,velocity,totalDx:-40,totalDy:0,axis:'horizontal',wasOpen:false});
 expect(settle(sampleVelocity(drag))).toBe(true);                    // so it opened the row by the flick's direction
 expect(settle(releaseVelocity(drag,{x:160,t:5248}))).toBe(false);   // now the 40px offset, short of the 68px halfway point, leaves it closed
});
