import {test,expect} from './local-planner-fixture.js';

// End-to-end checks for the tracked swipe in src/mobile-swipe.js (mobile-smooth-swipe, tasks 6.1 to 6.7 and 6.9).
//
// Drags are synthetic touch PointerEvents dispatched inside the page, the way tests/app.e2e.js drives the
// legacy swipe. page.mouse reports pointerType 'mouse', which the controller ignores, and page.touchscreen
// can only tap (design.md, "Correction found while amending"). Synthetic events are untrusted: they never
// scroll the page and never produce a click, so a test that needs either has to cause it some other way. The
// scroll tests send real touches through a CDP session instead; see touchDrag().
//
// What the controller requires, and the helpers below provide:
// - pointerType 'touch', and one pointerId for every event of a gesture;
// - a pointerdown outside any button, a, input, select, textarea or summary, so drags start on a card's h3;
// - pointermove, pointerup and pointercancel reaching the document's capture phase;
// - 8px of travel before the axis locks and anything is tracked;
// - --swipe-x written from a requestAnimationFrame callback, so reads wait two frames after the last move;
// - a release velocity over the 100ms that end at the pointerup, timed with performance.now(), from the
//   pointermove samples in that window plus the release position as the last sample (design.md,
//   "releaseVelocity (Amendment C)"). pointerdown adds no sample. The time between the last move and the release
//   lowers the velocity, and a release more than 100ms after the last move measures 0, so every flick below
//   releases straight after its last move. drag() holds still in two ways. {hold} sends a pointermove at the
//   same position every frame, so the window fills with moves that do not travel, and a release after
//   {hold:STILL_MS} measures 0. {pause} sends nothing, the way a browser sends no pointermove while a finger
//   rests, so the moves before it age out of the window: a release more than 100ms after the last move finds
//   only itself there and measures 0 (criterion 2.11).

// Every test runs the bundle the server serves now, never one a service worker cached, as receipt-ocr.e2e.js does.
test.use({serviceWorkers:'block'});

const PHONE={width:390,height:900};
// Panel geometry, calc(var(--swipe-count)*68px), the same constant the controller uses for End_Stop.
const ACTION_WIDTH=68;
// After {hold:STILL_MS}, every sample in the 100ms velocity window sits at one position, so a release then
// measures exactly 0 px/ms and the halfway rule decides. It must exceed 100ms plus one frame.
const STILL_MS=150;
// The release velocity's window in ms, and the speed in px/ms from which a release resolves by direction. The
// same constants as the controller's VELOCITY_WINDOW and FLICK_THRESHOLD.
const VELOCITY_WINDOW=100;
const FLICK_THRESHOLD=0.35;
// Past the End_Stop the surface renders RUBBER_RESIST of the overshoot, and at most RUBBER_MAX px past the stop. The
// same constants as the controller's RUBBER_RESIST and RUBBER_MAX.
const RUBBER_RESIST=0.3;
const RUBBER_MAX=48;

/** Load /demo/ at 390×900 (as app.e2e.js sizes the phone layout) and wait for the first card's swipe panel. */
async function openPhoneDemo(page){
 await page.setViewportSize(PHONE);
 await page.goto('/demo/');
 await expect(page.locator('.activity-card').first().locator('.swipe-actions')).toHaveCount(1);
}

// ---------------------------------------------------------------------------------------------------------
// Drag driver
// ---------------------------------------------------------------------------------------------------------

/**
 * In-page half of the drag driver. page.evaluate serializes this function, so it must not reference anything
 * outside its own body. Tests call drag(), dragMore() and endDrag() instead.
 *
 * plan.begin {at,pointerId} dispatches a pointerdown on plan.target at viewport point `at`, whose missing
 * coordinates default as drag() describes, and opens a gesture; plan.begin null continues the gesture this
 * page still has open. plan.moves then run in order, one pointermove per animation frame so every sample
 * gets its own timestamp, except that a {pause} step dispatches nothing in its frames. plan.end 'up' or
 * 'cancel' dispatches that event and closes the gesture, one frame after the last step, or straight after it
 * when plan.release is 'immediate'; 'none' leaves it open. Last, it waits plan.frames animation frames.
 */
async function runSyntheticGesture(plan){
 const KEY='__mobileSwipeE2eGesture';
 if(!['up','cancel','none'].includes(plan.end))throw new Error(`unknown drag end: ${plan.end}`);
 const release=plan.release??'next-frame';
 if(!['next-frame','immediate'].includes(release))throw new Error(`unknown drag release: ${release}`);
 const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
 // A touch pointer is implicitly captured by its pointerdown target, so every event of the gesture goes there.
 // If a re-render removed that element, the document receives the events instead, so they still arrive.
 // Returns true when a listener called preventDefault.
 const fire=(gesture,type)=>{
  const pressed=type==='pointerdown'||type==='pointermove';
  const event=new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,view:window,pointerId:gesture.pointerId,pointerType:'touch',isPrimary:true,clientX:gesture.x,clientY:gesture.y,screenX:gesture.x,screenY:gesture.y,button:type==='pointermove'?-1:0,buttons:pressed?1:0,pressure:pressed?0.5:0,width:1,height:1});
  return !(gesture.target.isConnected?gesture.target:document).dispatchEvent(event);
 };
 let gesture=window[KEY];
 if(plan.begin){
  if(gesture)throw new Error('a synthetic swipe gesture is still open; end it with endDrag() first');
  const target=plan.target,at=plan.begin.at??{};
  if(!(target instanceof Element))throw new Error('drag() needs a target element');
  const box=target.getBoundingClientRect();
  if((at.x===undefined||at.y===undefined)&&!(box.width&&box.height))throw new Error('drag target is not rendered');
  const x=Math.round(at.x??box.right-10),y=Math.round(at.y??box.top+box.height/2);
  gesture={target,pointerId:plan.begin.pointerId,startX:x,startY:y,x,y,samples:[],release:null};
  window[KEY]=gesture;
  fire(gesture,'pointerdown');
 }else if(!gesture){
  throw new Error('no synthetic swipe gesture is open; start one with drag()');
 }
 const move=(x,y)=>{
  gesture.x=x;gesture.y=y;
  const prevented=fire(gesture,'pointermove');
  gesture.samples.push({x,y,t:performance.now(),prevented});
 };
 for(const step of plan.moves){
  if(step.hold!==undefined){
   const until=performance.now()+step.hold;
   do{await frame();move(gesture.x,gesture.y);}while(performance.now()<until);
   continue;
  }
  // No event and no sample: the finger rests, and the gesture keeps its position.
  if(step.pause!==undefined){
   const until=performance.now()+step.pause;
   do await frame();while(performance.now()<until);
   continue;
  }
  const fromX=gesture.x,fromY=gesture.y,toX=gesture.startX+(step.dx??0),toY=gesture.startY+(step.dy??0);
  const steps=Math.max(1,Math.round(step.steps??Math.ceil(Math.hypot(toX-fromX,toY-fromY)/4)));
  for(let i=1;i<=steps;i+=1){
   await frame();
   // The last step lands exactly on the target, so rounding never leaves the displacement a hair short.
   move(i===steps?toX:fromX+(toX-fromX)*i/steps,i===steps?toY:fromY+(toY-fromY)*i/steps);
  }
 }
 if(plan.end!=='none'){
  if(release==='next-frame')await frame();
  fire(gesture,plan.end==='up'?'pointerup':'pointercancel');
  // Timed like a sample, after the dispatch, because the controller counts the release as one.
  gesture.release={x:gesture.x,y:gesture.y,t:performance.now()};
  delete window[KEY];
 }
 for(let i=0;i<(plan.frames??2);i+=1)await frame();
 const {pointerId,startX,startY,x,y,samples}=gesture;
 return {pointerId,startX,startY,x,y,dx:x-startX,dy:y-startY,active:window[KEY]===gesture,samples,release:gesture.release};
}

/**
 * Drag driver. Opens a touch gesture on `target`, a Locator whose element receives every event of the
 * gesture, runs `moves`, then ends the gesture.
 *   moves     a list of {dx,dy,steps}, {hold:ms} or {pause:ms}, run in order.
 *             {dx,dy,steps} moves to displacement (dx,dy) from the start point, not from the previous move;
 *             dx and dy default to 0. The move is split into `steps` equal pointermoves, one per frame, so a
 *             step covers (distance/steps) px in about 16.7ms at 60Hz. Without steps it is one frame per 4px,
 *             about 0.24 px/ms, below the 0.35 px/ms flick threshold. Release a flick with release:'immediate'
 *             and give it two moves or more, for example {dx:-20,steps:2} at about 0.6 px/ms. The release
 *             counts as a sample at the last move's position, so a single move measures 0, and the default
 *             release adds a frame at that position to the window, which halves the example to about 0.3 px/ms.
 *             {hold:ms} repeats the current position every frame for ms. Ending with {hold:STILL_MS} gives a
 *             release velocity of exactly 0. The velocity covers the 100ms before the release, so a reversal
 *             flick right after other movement is diluted: hold still first, then cover more than 35px in
 *             under 100ms, which measures above 0.35 px/ms however much of the hold the window still holds.
 *             {pause:ms} waits animation frames until ms have passed, at least one, and dispatches nothing, so
 *             samples gains no entry. It stands for a resting finger, which fires no pointermove. Where
 *             {hold} keeps the velocity window full of moves at one position, {pause} lets the moves before it
 *             age out of the window, so a release more than 100ms after the last move measures 0 (criterion
 *             2.11). A shorter pause leaves moves in the window, and the release measures their slope to it.
 *   at        start point {x,y} in viewport coordinates. A missing x is 10px inside the target's right edge
 *             and a missing y is its vertical centre. The point is rounded to whole pixels so integer
 *             displacements stay exact. The driver never scrolls. The controller reads only coordinates, so
 *             a row below the fold drags fine, but hitTest() returns null off screen: at 390×900 the first
 *             activity card starts below the fold, so call `await row.scrollIntoViewIfNeeded()` before a
 *             drag whose positions a test will hit-test.
 *   end       'up' (default), 'cancel', or 'none' to leave the gesture open for mid-drag reads; continue it
 *             with dragMore() and close it with endDrag(). Only one gesture can be open per page.
 *   release   when the end event fires: 'next-frame' (default) one frame after the last step, or 'immediate'
 *             straight after it, in the same frame. Every flick uses 'immediate', because the controller
 *             counts the release in its velocity. Ignored when end is 'none'.
 *   frames    animation frames to wait after the last event (default 2), enough for the --swipe-x write.
 *   pointerId default 2, so Playwright's mouse, which uses pointerId 1, cannot join the gesture.
 * Resolves to {pointerId,startX,startY,x,y,dx,dy,active,samples,release}. samples holds one {x,y,t,prevented}
 * per pointermove of the gesture so far: t is performance.now() at dispatch, and prevented is whether the
 * controller called preventDefault on that move. release is {x,y,t} of the pointerup or pointercancel, timed
 * the same way, or null while the gesture is open. From the two, measuredReleaseVelocity() recomputes the
 * release velocity the controller saw.
 */
async function drag(page,target,moves=[],{at,end='up',release='next-frame',frames=2,pointerId=2}={}){
 const handle=await target.elementHandle();
 try{return await page.evaluate(runSyntheticGesture,{target:handle,begin:{at:at??null,pointerId},moves,end,release,frames});}
 finally{await handle.dispose();}
}
/** Continue the open gesture with more moves. Same moves, options and result as drag(); end defaults to 'up'. */
const dragMore=(page,moves,{end='up',release='next-frame',frames=2}={})=>page.evaluate(runSyntheticGesture,{target:null,begin:null,moves,end,release,frames});
/**
 * End the open gesture where it is with 'up' (default) or 'cancel'. Same result as drag(). release:'immediate'
 * dispatches the event at once instead of a frame later.
 */
const endDrag=(page,end='up',{release='next-frame',frames=2}={})=>page.evaluate(runSyntheticGesture,{target:null,begin:null,moves:[],end,release,frames});

/**
 * The release velocity in px/ms, negative leftward, that the controller measured for a gesture `result` from
 * drag(), dragMore() or endDrag() that has ended. As design.md's releaseVelocity defines it: the slope from the
 * earliest sample in the VELOCITY_WINDOW ms before the release to the release; 0 when no sample falls in that
 * window or it has no width; null for a gesture with no pointermove. Computed here, not imported, so the check
 * does not depend on the code under test.
 */
function measuredReleaseVelocity({samples,release}){
 if(!release)throw new Error('the gesture is still open, so it has no release velocity');
 if(!samples.length)return null;
 const first=samples.find(sample=>release.t-sample.t<=VELOCITY_WINDOW);
 const dt=first?release.t-first.t:0;
 return dt>0?(release.x-first.x)/dt:0;
}

// ---------------------------------------------------------------------------------------------------------
// Real touch input
// ---------------------------------------------------------------------------------------------------------

/** In-page: start recording every pointer event the window sees, in the capture phase, before any page listener. */
function startPointerLog(){
 const KEY='__mobileSwipeE2ePointerLog';
 if(window[KEY])throw new Error('a pointer log is already recording');
 const log={events:[],record:event=>log.events.push({event,t:performance.now()})};
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])window.addEventListener(type,log.record,true);
 window[KEY]=log;
}

/**
 * In-page: the pointer events recorded since startPointerLog(), oldest first, with t the page's performance.now() at
 * arrival. defaultPrevented is read now, after each dispatch has finished, so it shows whether a listener called
 * preventDefault. With `stop` true, recording ends.
 */
function readPointerLog(stop){
 const KEY='__mobileSwipeE2ePointerLog',log=window[KEY];
 if(!log)throw new Error('no pointer log is recording');
 if(stop){
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])window.removeEventListener(type,log.record,true);
  delete window[KEY];
 }
 return log.events.map(({event,t})=>({type:event.type,isTrusted:event.isTrusted,pointerType:event.pointerType,pointerId:event.pointerId,x:event.clientX,y:event.clientY,t,defaultPrevented:event.defaultPrevented}));
}

/**
 * Real touch input, for the tests that need the browser's own panning. Synthetic PointerEvents never scroll the page,
 * so this drives the finger through a CDP session's Input.dispatchTouchEvent, which produces trusted touch pointer
 * events that go through the browser's touch-action handling. No touch emulation is needed.
 *   from    a Locator for the element the finger lands on, at the centre of its bounding box rounded to whole
 *           pixels. The browser hit-tests the touch, so that point must be on screen and hit the element or one of its
 *           descendants: scroll the row into view first, and start on a card's h3, as with drag().
 *   moves   a list of {dx,dy,steps}, as drag() takes them: each moves to displacement (dx,dy) from the landing point
 *           in `steps` touchMoves, one per animation frame, or one per 4px without steps. The last step lands exactly
 *           on the target.
 *   end     'up' (default) lifts the finger with touchEnd; 'cancel' ends the touch with touchCancel.
 *   sample  an optional async function, called after each touchMove's frame while the finger is still down. Its
 *           result is stored on that move's point, which is how a test reads the row mid-drag.
 *   frames  animation frames to wait after the end event (default 2).
 * The browser pans only once the finger has moved past its touch slop. When it starts panning it sends pointercancel,
 * and no more pointer events for that touch. Resolves to {start,points,release,pointerEvents}: start is the landing
 * point {x,y}; points holds one {x,y,dx,dy,t,sample} per touchMove, t being ms since the touchStart was sent; release
 * is {type,t} of the end event; pointerEvents is every pointer event the window saw from the touchStart on, as
 * readPointerLog() reports them. The CDP session is detached before it resolves.
 */
async function touchDrag(page,from,moves=[],{end='up',sample,frames:after=2}={}){
 if(!['up','cancel'].includes(end))throw new Error(`unknown touch end: ${end}`);
 const box=await from.boundingBox();
 if(!box)throw new Error('touch target is not rendered');
 const start={x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};
 const landing=await from.evaluate((el,{x,y})=>{
  const hit=document.elementFromPoint(x,y);
  return {inside:!!hit&&el.contains(hit),hit:hit?`${hit.tagName.toLowerCase()} class="${hit.getAttribute('class')??''}"`:'nothing'};
 },start);
 if(!landing.inside)throw new Error(`a touch at (${start.x}, ${start.y}) would land on ${landing.hit}, outside the touch target`);
 const cdp=await page.context().newCDPSession(page);
 let x=start.x,y=start.y,down=false;
 const send=type=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchStart'||type==='touchMove'?[{x,y}]:[]});
 try{
  await page.evaluate(startPointerLog);
  const began=performance.now(),points=[];
  await send('touchStart');
  down=true;
  await frames(page,1);
  const [first]=await page.evaluate(readPointerLog,false);
  if(first?.type!=='pointerdown'||!first.isTrusted||first.pointerType!=='touch')throw new Error(`the touchStart produced ${first?`${first.isTrusted?'a trusted':'an untrusted'} ${first.pointerType} ${first.type}`:'no pointer event'}, not a trusted touch pointerdown`);
  for(const step of moves){
   const fromX=x,fromY=y,toX=start.x+(step.dx??0),toY=start.y+(step.dy??0);
   const steps=Math.max(1,Math.round(step.steps??Math.ceil(Math.hypot(toX-fromX,toY-fromY)/4)));
   for(let i=1;i<=steps;i+=1){
    x=i===steps?toX:fromX+(toX-fromX)*i/steps;
    y=i===steps?toY:fromY+(toY-fromY)*i/steps;
    await send('touchMove');
    const point={x,y,dx:x-start.x,dy:y-start.y,t:performance.now()-began};
    points.push(point);
    await frames(page,1);
    if(sample)point.sample=await sample(point);
   }
  }
  const type=end==='up'?'touchEnd':'touchCancel';
  await send(type);
  down=false;
  const release={type,t:performance.now()-began};
  await frames(page,after);
  return {start,points,release,pointerEvents:await page.evaluate(readPointerLog,true)};
 }finally{
  // A failure mid-gesture still ends the touch, so the browser holds no finger down past this call.
  if(down)await send('touchCancel').catch(()=>{});
  await cdp.detach();
 }
}

/** touchDrag()'s pointerEvents on one line, for an annotation: each run of identical entries with its count. */
function summarizePointerEvents(events){
 const runs=[];
 for(const {type,isTrusted,defaultPrevented} of events){
  const label=`${isTrusted?'':'untrusted '}${type}${defaultPrevented?' (default prevented)':''}`;
  if(runs.at(-1)?.label===label)runs.at(-1).count+=1;
  else runs.push({label,count:1});
 }
 return runs.map(({label,count})=>count>1?`${label} x${count}`:label).join(', ')||'none';
}

// ---------------------------------------------------------------------------------------------------------
// Readers. `row` is a Locator for a prepared swipe row, such as page.locator('.activity-card').first().
// ---------------------------------------------------------------------------------------------------------

/**
 * In-page: one computed style property of a row's surface child. The surface is every direct child except
 * .swipe-actions and .swipe-toggle; all of them read the same --swipe-x. This picks the first one that has a
 * layout box, or the first direct child matching `selector` when one is given.
 */
function readSurfaceStyle(row,{property,selector}){
 const surface=[...row.children].filter(el=>selector?el.matches(selector):!el.matches('.swipe-actions,.swipe-toggle'));
 const child=surface.find(el=>el.getClientRects().length>0)??surface[0];
 if(!child)throw new Error(`swipe row has no surface child${selector?` matching ${selector}`:''}`);
 return getComputedStyle(child).getPropertyValue(property);
}

/** Rendered translateX in px of a row's surface child, parsed from its computed transform matrix ('none' is 0). */
async function surfaceTranslateX(row,selector){
 const transform=(await row.evaluate(readSurfaceStyle,{property:'transform',selector})).trim();
 if(transform==='none')return 0;
 const match=/^matrix(3d)?\(([^)]*)\)$/.exec(transform);
 if(!match)throw new Error(`unexpected computed transform: ${transform}`);
 const values=match[2].split(',').map(Number);
 return values[match[1]?12:4];
}

/**
 * Computed transition-duration of a row's surface child as the browser serializes it: '0s' mid-drag and under
 * reduced motion, '0.26s' otherwise.
 */
const surfaceTransitionDuration=(row,selector)=>row.evaluate(readSurfaceStyle,{property:'transition-duration',selector});

/** The longest entry in ms of a computed time list such as '0.26s' or '0.26s, 0s'. */
function durationMs(value){
 return Math.max(...value.split(',').map(entry=>{
  const match=/^(\d*\.?\d+(?:e[-+]?\d+)?)(m?s)$/i.exec(entry.trim());
  if(!match)throw new Error(`unexpected computed duration: ${value}`);
  return Number(match[1])*(match[2].toLowerCase()==='ms'?1:1000);
 }));
}

/** The row's inline --swipe-x, such as '-40px', or '' once the value is handed back to the class rule. */
const inlineSwipeX=row=>row.evaluate(el=>el.style.getPropertyValue('--swipe-x').trim());

/** End_Stop of a row in px, from the --swipe-count that prepare() sets inline: -136 for a two-action row. */
async function endStop(row){
 const count=Number(await row.evaluate(el=>el.style.getPropertyValue('--swipe-count')));
 return count?-ACTION_WIDTH*count:0;
}

/**
 * Left inset in px of the panel's computed clip-path, inset(top right bottom left), or null when it is 'none'.
 * Panel_Visible_Width is the panel's box width minus this value; past the End_Stop the inset goes negative.
 */
async function panelClipLeft(row){
 const clip=(await row.evaluate(el=>{
  const panel=[...el.children].find(child=>child.matches('.swipe-actions'));
  if(!panel)throw new Error('swipe row has no .swipe-actions panel');
  return getComputedStyle(panel).clipPath;
 })).trim();
 if(clip==='none')return null;
 const match=/^inset\((.*)\)$/.exec(clip);
 if(!match)throw new Error(`unexpected computed clip-path: ${clip}`);
 const values=match[1].split(/\s+round\s/)[0].trim().split(/\s+/);
 // Margin-style shorthand: 1 value is every side, 2 are vertical horizontal, 3 are top horizontal bottom.
 const left=values[[0,1,1,3][values.length-1]];
 if(!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?px$/i.test(left??''))throw new Error(`clip-path left inset is not a px length: ${clip}`);
 return Number.parseFloat(left);
}

/**
 * panelClipLeft(), recorded on the running test as a 'panel clip-path left inset' annotation together with the surface
 * translateX it was read with, so the report keeps the value even when nothing asserts on it. `what` names the read.
 * Resolves to the same value as panelClipLeft().
 */
async function recordPanelClipLeft(row,what){
 const clipLeft=await panelClipLeft(row),translateX=await surfaceTranslateX(row);
 test.info().annotations.push({type:'panel clip-path left inset',description:`${what}: ${clipLeft===null?'none':`${clipLeft}px`}, surface translateX ${translateX}px`});
 return clipLeft;
}

/**
 * A mid-drag reading of a row, as touchDrag()'s `sample` takes it: whether it has .swipe-dragging, its inline
 * --swipe-x ('' when unset), the surface translateX, and the page's scrollY.
 */
async function trackingState(row){
 const {dragging,swipeX,scrollY}=await row.evaluate(el=>({dragging:el.classList.contains('swipe-dragging'),swipeX:el.style.getPropertyValue('--swipe-x').trim(),scrollY:window.scrollY}));
 return {dragging,swipeX,translateX:await surfaceTranslateX(row),scrollY};
}

/** Every swipe row on the page, in document order, as {index,className,swipeX}: its class attribute and inline --swipe-x. */
const swipeRowStates=page=>page.evaluate(()=>[...document.querySelectorAll('.swipe-row')].map((row,index)=>({index,className:row.className,swipeX:row.style.getPropertyValue('--swipe-x').trim()})));

// ---------------------------------------------------------------------------------------------------------
// Hit testing and timing
// ---------------------------------------------------------------------------------------------------------

/** In-page: elementFromPoint while a test-only style forces pointer-events:auto on every panel and its buttons. */
function hitTestThroughPanels({x,y}){
 const style=document.createElement('style');
 style.textContent='.swipe-row>.swipe-actions,.swipe-row>.swipe-actions *{pointer-events:auto!important}';
 document.head.append(style);
 try{
  const hit=document.elementFromPoint(x,y);
  if(!hit)return null;
  const action=hit.closest('.swipe-actions>.swipe-action');
  return {tag:hit.tagName.toLowerCase(),className:hit.getAttribute('class')??'',inPanel:!!hit.closest('.swipe-actions'),panelButton:action?action.dataset.swipeLabel??'':null};
 }finally{
  style.remove();
 }
}

/**
 * What paints on top at (x,y), with pointer-events set aside. The dragging panel is pointer-events:none, so a
 * plain elementFromPoint skips it and a panel covering the surface would go unseen. visibility and clip-path
 * still apply. x and y are viewport coordinates, the space Locator.boundingBox() reports, so a scrolled page
 * needs no correction (CDP DOM.getNodeForLocation takes page coordinates instead). Resolves to null outside the
 * viewport, otherwise {tag,className,inPanel,panelButton}: panelButton is the hit panel button's
 * data-swipe-label ('編輯' or '刪除'), or null when the hit is not a panel button.
 */
const hitTest=(page,x,y)=>page.evaluate(hitTestThroughPanels,{x,y});

/** Resolve after `count` animation frames (default 2). */
const frames=(page,count=2)=>page.evaluate(async n=>{for(let i=0;i<n;i+=1)await new Promise(resolve=>requestAnimationFrame(resolve));},count);

/** In-page: resolve once the row has neither .swipe-dragging nor .swipe-settling and no CSS transition runs inside it. */
async function waitUntilRowRests(row,timeoutMs){
 const deadline=performance.now()+timeoutMs;
 const moving=()=>row.classList.contains('swipe-dragging')||row.classList.contains('swipe-settling')||row.getAnimations({subtree:true}).some(animation=>typeof animation.transitionProperty==='string');
 while(moving()){
  if(performance.now()>deadline)throw new Error(`swipe row still moving after ${timeoutMs}ms (class="${row.className}")`);
  await new Promise(resolve=>requestAnimationFrame(resolve));
 }
}

/** Wait until a settle has finished and the row shows its resting state. Rejects after timeoutMs (default 2000). */
const waitForRest=(row,timeoutMs=2000)=>row.evaluate(waitUntilRowRests,timeoutMs);

// ---------------------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------------------

/**
 * Assert that a reading in px is within 1px of `expected`, the tolerance the criteria allow. `what` names the
 * reading, and the failure message shows it next to both values. A NaN reading fails.
 */
function expectWithin1px(actual,expected,what){
 expect(Math.abs(actual-expected),`${what}: ${actual}px, expected ${expected}px within 1px`).toBeLessThanOrEqual(1);
}

/**
 * The surface's transition-duration, read while a settle runs. .swipe-settling is on the row from the release
 * until the settle ends, so finding it before and after the read shows the read fell inside the settle. Call it
 * straight after the releasing drag() resolves, which is two frames after the release.
 */
async function settleTransitionDuration(row,what){
 const settling=()=>row.evaluate(el=>el.classList.contains('swipe-settling'));
 expect(await settling(),`${what}: .swipe-settling before the read`).toBe(true);
 const duration=await surfaceTransitionDuration(row);
 expect(await settling(),`${what}: .swipe-settling after the read`).toBe(true);
 return duration;
}

/**
 * Wait for the settle to end, then assert the resting state of `open` (Requirements 2.6 to 2.8): the state
 * class, the surface translateX within 1px of the End_Stop or of 0, no inline --swipe-x, the panel's aria-hidden
 * and the toggle's aria-expanded. The toggle is display:none while the row is open, but its attribute still
 * reads. `what` names the step in failure messages.
 */
async function expectSettled(row,open,what){
 if(open)await expect(row,`${what}: row state`).toHaveClass(/swipe-open/);
 else await expect(row,`${what}: row state`).not.toHaveClass(/swipe-open/);
 await waitForRest(row);
 expectWithin1px(await surfaceTranslateX(row),open?await endStop(row):0,`${what}: settled surface translateX`);
 expect(await inlineSwipeX(row),`${what}: inline --swipe-x after the settle`).toBe('');
 await expect(row.locator('.swipe-actions'),`${what}: panel aria-hidden`).toHaveAttribute('aria-hidden',String(!open));
 await expect(row.locator('.swipe-toggle'),`${what}: toggle aria-expanded`).toHaveAttribute('aria-expanded',String(open));
}

// ---------------------------------------------------------------------------------------------------------
// Tests. Tasks 6.2 to 6.7 and 6.9 add theirs below the smoke test.
// ---------------------------------------------------------------------------------------------------------

test('[TC-SWIPE-002] a tracked touch drag writes its offset to the inline --swipe-x',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 await drag(page,card.locator('h3'),[{dx:-40}],{end:'none'});
 expect(await inlineSwipeX(card)).toBe('-40px');
 await endDrag(page,'cancel');
 expect(errors).toEqual([]);
});

// Requirements 1.3, 1.4 and 1.5.
test('[TC-SWIPE-003] a 40px drag moves only the surface, 1:1 with the finger and with no transition',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 // At rest the surface has a transition, so a '0s' read mid-drag shows the drag turned it off.
 expect(await surfaceTransitionDuration(card),'surface transition-duration at rest').not.toBe('0s');
 const {dx}=await drag(page,card.locator('h3'),[{dx:-40}],{end:'none'});
 expectWithin1px(await surfaceTranslateX(card),dx,'surface translateX mid-drag');
 await expect(card.locator('.swipe-actions'),'panel transform mid-drag').toHaveCSS('transform','none');
 await expect(card.locator('.swipe-toggle'),'toggle transform mid-drag').toHaveCSS('transform','none');
 expect(await surfaceTransitionDuration(card),'surface transition-duration mid-drag').toBe('0s');
 await endDrag(page,'cancel');
});

// Requirement 1.6. The axis locks at 8px and no offset is written before then, so at 1px the panel is visible but
// still clipped to a Panel_Visible_Width of 0. This test reads only its visibility.
test('[TC-SWIPE-004] the action panel turns visible at the first leftward pixel, before release',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),panel=card.locator('.swipe-actions');
 await expect(panel,'panel visibility at rest').toHaveCSS('visibility','hidden');
 await drag(page,card.locator('h3'),[{dx:-1}],{end:'none'});
 await expect(panel,'panel visibility 1px into the drag').toHaveCSS('visibility','visible');
 await endDrag(page,'cancel');
});

// Requirement 1.7. The open row closes when the dragged row's axis first resolves to horizontal, at 8px.
test('[TC-SWIPE-005] dragging one row closes the row that was open',async({page})=>{
 await openPhoneDemo(page);
 const cards=page.locator('.activity-card'),rowA=cards.nth(0),rowB=cards.nth(1);
 // Open A through the release-only path that tests/app.e2e.js drives. With no pointermove there is no velocity,
 // so the 56px distance rule opens the row at any frame rate.
 const heading=rowA.locator('h3'),box=await heading.boundingBox();
 await heading.dispatchEvent('pointerdown',{pointerType:'touch',clientX:box.x+box.width-10,clientY:box.y+10});
 await heading.dispatchEvent('pointerup',{pointerType:'touch',clientX:box.x+box.width-95,clientY:box.y+10});
 await expect(rowA,'row A after its release-only swipe').toHaveClass(/swipe-open/);
 await waitForRest(rowA);
 await drag(page,rowB.locator('h3'),[{dx:-20}],{end:'none'});
 await expect(rowA,'row A while row B is dragged').not.toHaveClass(/swipe-open/);
 await endDrag(page);
});

// Requirement 1.9, from Amendment A. The panel paints above the surface, so it must be clipped to the strip the
// surface has moved off. hitTest() sets the dragging panel's pointer-events:none aside; clip-path still applies.
test('[TC-SWIPE-006] the action panel shows exactly the strip the dragged surface has uncovered',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),panel=card.locator('.swipe-actions');
 const stop=await endStop(card);
 expect(stop,'End_Stop of the two-action first card').toBe(-2*ACTION_WIDTH);
 // hitTest() returns null off screen, and at 390×900 the first card starts below the fold.
 await card.scrollIntoViewIfNeeded();
 // One gesture visits each distance in turn.
 await drag(page,card.locator('h3'),[],{end:'none'});
 for(const distance of [20,68,136]){
  const {dx}=await dragMore(page,[{dx:-distance}],{end:'none'});
  const translateX=await surfaceTranslateX(card),box=await panel.boundingBox(),clipLeft=await panelClipLeft(card);
  expectWithin1px(translateX,dx,`surface translateX at ${distance}px`);
  // A clip-path of none would leave the whole box showing.
  expectWithin1px(box.width-(clipLeft??0),Math.abs(translateX),`panel width ${box.width} minus clip-path left inset ${clipLeft} at ${distance}px`);
  // The surface has moved off the row's right |translateX| px, and the panel's right edge is the row's.
  const edge=box.x+box.width-Math.abs(translateX),y=box.y+box.height/2;
  expect(await hitTest(page,edge+2,y),`hit 2px inside the ${distance}px strip, at (${edge+2}, ${y})`).toMatchObject({inPanel:true,panelButton:expect.any(String)});
  // At the End_Stop the strip is the whole panel, so the point 2px outside it is left of the panel box.
  if(distance<-stop)expect(await hitTest(page,edge-2,y),`hit 2px outside the ${distance}px strip, at (${edge-2}, ${y})`).toMatchObject({inPanel:false});
 }
 await endDrag(page,'cancel');
});

// Requirements 2.1, 2.6 and 2.7. A 20px release is short of halfway, 68px on this card, and of the legacy rule's
// 56px, so only the flick rule can open the row.
test('[TC-SWIPE-007] a fast 20px leftward flick opens the row',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 const flick=await drag(page,card.locator('h3'),[{dx:-20,steps:2}],{release:'immediate'});
 expect(measuredReleaseVelocity(flick),'release velocity of the leftward flick, px/ms').toBeLessThanOrEqual(-FLICK_THRESHOLD);
 await expectSettled(card,true,'after the leftward flick');
});

// Requirements 2.2, 2.6 and 2.8. The flick runs from -130px to -70px and ends past halfway, so the halfway rule would
// open the row and only the flick rule closes it. The hold keeps the leftward drag out of the velocity window, and 60px
// in two frames measures above 0.35 px/ms even while the window still holds samples from the hold.
test('[TC-SWIPE-008] after a drag past 100px, a fast rightward flick closes the row though it ends past halfway',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 const flick=await drag(page,card.locator('h3'),[{dx:-130},{hold:STILL_MS},{dx:-70,steps:2}],{release:'immediate'});
 expect(measuredReleaseVelocity(flick),'release velocity of the rightward flick, px/ms').toBeGreaterThanOrEqual(FLICK_THRESHOLD);
 await expectSettled(card,false,'after the rightward flick');
});

// Requirements 2.3, 2.4, 2.6, 2.7 and 2.8. Each release follows {hold:STILL_MS}, so it measures 0 px/ms and the
// halfway rule decides at 68px. The release-only legacy rule would open at 56px, so the 60px release settling closed
// shows that the halfway rule decided it.
test('[TC-SWIPE-009] a slow release settles closed short of halfway and open past it',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 const short=await drag(page,heading,[{dx:-60},{hold:STILL_MS}]);
 expect(measuredReleaseVelocity(short),'release velocity after the 60px drag and hold, px/ms').toBe(0);
 await expectSettled(card,false,'after the slow 60px release');
 const past=await drag(page,heading,[{dx:-80},{hold:STILL_MS}]);
 expect(measuredReleaseVelocity(past),'release velocity after the 80px drag and hold, px/ms').toBe(0);
 await expectSettled(card,true,'after the slow 80px release');
});

// Requirements 2.5 to 2.8. The row opens and then closes by slow releases, and the surface's transition-duration is
// read while each settle runs. Before this feature only the open state carried a transition, so closing snapped.
test('[TC-SWIPE-010] opening and closing settles share one transition-duration of at most 320ms',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 await drag(page,heading,[{dx:-80},{hold:STILL_MS}]);
 const opening=await settleTransitionDuration(card,'opening settle');
 await expectSettled(card,true,'after opening');
 // From the open row, 76px rightward leaves the surface 60px from closed, short of halfway.
 await drag(page,heading,[{dx:76},{hold:STILL_MS}]);
 const closing=await settleTransitionDuration(card,'closing settle');
 await expectSettled(card,false,'after closing');
 expect(closing,'closing settle transition-duration, against the opening one').toBe(opening);
 expect(durationMs(opening),`settle transition-duration ${opening} in ms`).toBeGreaterThan(0);
 expect(durationMs(opening),`settle transition-duration ${opening} in ms`).toBeLessThanOrEqual(320);
});

// Requirements 3.1, 3.2 and 3.3. One gesture drags the closed first card past its End_Stop of -136px. At 200px the raw
// overshoot is 64px, so the surface renders 0.3 × 64 = 19.2px past the stop, at -155.2px. At 400px the raw overshoot is
// 264px, and 0.3 × 264 = 79.2px is over the 48px cap, so the surface holds at -184px. The gesture then holds still for
// STILL_MS before the release, so the release measures 0 px/ms and the halfway rule decides at any frame rate.
// Past the End_Stop the panel clip's left inset goes negative. Amendment A records the gap of up to 48px between the
// surface and the panel there as a known limitation, so the test records the inset and checks only that it clips
// nothing from the panel.
test('[TC-SWIPE-011] past the End_Stop the surface moves 0.3 times the overshoot, at most 48px, and a release there opens the row',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 const stop=await endStop(card);
 expect(stop,'End_Stop of the two-action first card').toBe(-2*ACTION_WIDTH);
 // The row starts closed, so the raw offset, startOffset + dx, is dx, and the raw overshoot is stop - dx.
 const proportional=await drag(page,card.locator('h3'),[{dx:-200}],{end:'none'});
 const overshoot=stop-proportional.dx,rendered=stop-await surfaceTranslateX(card);
 expectWithin1px(rendered,RUBBER_RESIST*overshoot,`rendered overshoot at dx ${proportional.dx}px, for a raw overshoot of ${overshoot}px`);
 expect(rendered,`rendered overshoot at dx ${proportional.dx}px, against the raw overshoot of ${overshoot}px`).toBeLessThan(overshoot);
 expect(rendered,`rendered overshoot at dx ${proportional.dx}px, against the cap`).toBeLessThanOrEqual(RUBBER_MAX);
 expect(await recordPanelClipLeft(card,`dx ${proportional.dx}px`)??0,`panel clip-path left inset at dx ${proportional.dx}px`).toBeLessThanOrEqual(0);
 const capped=await dragMore(page,[{dx:-400}],{end:'none'});
 expectWithin1px(stop-await surfaceTranslateX(card),RUBBER_MAX,`rendered overshoot at dx ${capped.dx}px, for a raw overshoot of ${stop-capped.dx}px`);
 expect(await recordPanelClipLeft(card,`dx ${capped.dx}px`)??0,`panel clip-path left inset at dx ${capped.dx}px`).toBeLessThanOrEqual(0);
 const released=await dragMore(page,[{hold:STILL_MS}]);
 expect(measuredReleaseVelocity(released),'release velocity after the hold past the End_Stop, px/ms').toBe(0);
 await expectSettled(card,true,'after the release past the End_Stop');
});

// Requirement 3.4. A row the controller did not track would also render 0, so the inline --swipe-x of 0px shows that
// the tracker followed the rightward drag and clamped it. pointercancel ends the gesture, so no release rule runs.
test('[TC-SWIPE-012] a closed row dragged rightward holds at 0',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 const {dx}=await drag(page,card.locator('h3'),[{dx:100}],{end:'none'});
 expectWithin1px(await surfaceTranslateX(card),0,`surface translateX of the closed row at dx ${dx}px`);
 expect(await inlineSwipeX(card),`inline --swipe-x of the closed row at dx ${dx}px`).toBe('0px');
 await recordPanelClipLeft(card,`closed row at dx ${dx}px`);
 await endDrag(page,'cancel');
});

// Requirement 3.5. The first card opens by a slow 80px release, as in the halfway test above, and is then dragged
// rightward. At 68px the surface is at -68px, still 1:1 with the finger; at 200px, 64px past closed, it holds at 0.
// pointercancel ends the gesture and settles the row back open, so no release rule decides the outcome.
test('[TC-SWIPE-013] an open row dragged rightward tracks back to 0 and holds there',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 const stop=await endStop(card);
 await drag(page,heading,[{dx:-80},{hold:STILL_MS}]);
 await expect(card,'row state after the slow 80px release').toHaveClass(/swipe-open/);
 await waitForRest(card);
 const tracking=await drag(page,heading,[{dx:68}],{end:'none'});
 expectWithin1px(await surfaceTranslateX(card),stop+tracking.dx,`surface translateX of the open row at dx ${tracking.dx}px`);
 await recordPanelClipLeft(card,`open row at dx ${tracking.dx}px`);
 const held=await dragMore(page,[{dx:200}],{end:'none'});
 expectWithin1px(await surfaceTranslateX(card),0,`surface translateX of the open row at dx ${held.dx}px`);
 await recordPanelClipLeft(card,`open row at dx ${held.dx}px`);
 await endDrag(page,'cancel');
});

// Requirement 4.3. Synthetic events never scroll the page, so this drag is a real touch. Its first move locks the axis to
// vertical with the drift already leftward and the finger still inside the browser's touch slop, so a controller that
// went on treating the gesture as a swipe after the vertical lock would mark the row .swipe-dragging there, before the
// browser starts panning. The finger moves down, so the page scrolls toward the top, which it can from the first card.
// Whether the browser sends pointercancel when it starts panning is recorded, not asserted.
test('[TC-SWIPE-014] a mostly vertical touch drag scrolls the page and never tracks the row',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 await card.scrollIntoViewIfNeeded();
 const baseline=await page.evaluate(()=>window.scrollY);
 expect(baseline,'page scrollY with the first card scrolled into view').toBeGreaterThan(0);
 const touch=await touchDrag(page,card.locator('h3'),[{dx:-3,dy:12,steps:1},{dx:-4,dy:150}],{sample:()=>trackingState(card)});
 for(const {dx,dy,sample} of touch.points){
  const at=`(${dx.toFixed(1)}, ${dy.toFixed(1)})`;
  expect(sample.dragging,`.swipe-dragging with the finger at ${at}`).toBe(false);
  expect(sample.swipeX,`inline --swipe-x with the finger at ${at}`).toBe('');
  expectWithin1px(sample.translateX,0,`surface translateX with the finger at ${at}`);
 }
 const scrolled=touch.points.at(-1).sample.scrollY;
 expect(scrolled,`page scrollY with the finger still down at the end of the drag, against ${baseline} before it`).toBeLessThan(baseline);
 const cancelAt=touch.pointerEvents.findIndex(event=>event.type==='pointercancel');
 const moved=touch.pointerEvents.slice(0,cancelAt<0?touch.pointerEvents.length:cancelAt).filter(event=>event.type==='pointermove');
 const offset=event=>`(${(event.x-touch.start.x).toFixed(1)}, ${(event.y-touch.start.y).toFixed(1)})`;
 test.info().annotations.push({type:'vertical touch drag',description:[
  `scrollY ${baseline} before the drag and ${scrolled} at its end, with the finger down`,
  cancelAt<0?'the browser sent no pointercancel':`the browser sent pointercancel after ${moved.length} pointermove${moved.length===1?'':'s'}${moved.length?`, the last at ${offset(moved.at(-1))}`:''}`,
  `pointer events: ${summarizePointerEvents(touch.pointerEvents)}`
 ].join('; ')});
 await expectSettled(card,false,'after the vertical drag');
});

// Requirement 4.4. A real touch again, since the claim is that the page does not scroll. The axis locks to horizontal at
// 8px and the row tracks the finger, while the rows' touch-action:pan-y keeps the browser from panning sideways. The
// touchCancel ends the touch the way the browser ends one it takes over, so the row settles closed whatever the release
// velocity would have been.
test('[TC-SWIPE-015] a mostly horizontal touch drag tracks the row and leaves the page where it was',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 await card.scrollIntoViewIfNeeded();
 const baseline=await page.evaluate(()=>window.scrollY);
 const touch=await touchDrag(page,card.locator('h3'),[{dx:-40,dy:3}],{end:'cancel',sample:()=>trackingState(card)});
 const {dx,dy,sample}=touch.points.at(-1);
 expectWithin1px(Number.parseFloat(sample.swipeX),dx,`inline --swipe-x "${sample.swipeX}" with the finger down at (${dx}, ${dy})`);
 expect(touch.points.map(point=>point.sample.scrollY),`page scrollY after each touchMove, against ${baseline} before the drag`).toEqual(touch.points.map(()=>baseline));
 test.info().annotations.push({type:'horizontal touch drag',description:`pointer events: ${summarizePointerEvents(touch.pointerEvents)}`});
 await expectSettled(card,false,'after the touchCancel');
});

// Requirement 4.5. A pointercancel settles the row to the state it held when the gesture started, and no release rule
// runs. So the closed first card is dragged 40px, short of halfway, and then 100px, past it, where a slow release would
// open it, and both cancels settle it closed. The inline --swipe-x read before each cancel is the tracked value the
// cancel has to clear, and the transition-duration read during the settle shows that the row animates back.
test('[TC-SWIPE-016] a pointercancel settles a closed row back to closed and clears its inline --swipe-x',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 for(const distance of [40,100]){
  const {dx}=await drag(page,heading,[{dx:-distance}],{end:'none'});
  expect(await inlineSwipeX(card),`inline --swipe-x of the closed row at dx ${dx}px`).toBe(`${dx}px`);
  await endDrag(page,'cancel');
  const duration=await settleTransitionDuration(card,`settle after the cancel at dx ${dx}px`);
  expect(durationMs(duration),`settle transition-duration ${duration} after the cancel at dx ${dx}px, in ms`).toBeGreaterThan(0);
  await expectSettled(card,false,`after the cancel at dx ${dx}px`);
 }
});

// Requirement 4.5, from the open row, opened by a slow 80px release. Dragged 40px rightward the surface is still past
// halfway, and 100px leaves it 36px from closed, where a slow release would close it. Both cancels settle it open.
test('[TC-SWIPE-017] a pointercancel settles an open row back to open and clears its inline --swipe-x',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 const stop=await endStop(card);
 await drag(page,heading,[{dx:-80},{hold:STILL_MS}]);
 await expect(card,'row state after the slow 80px release').toHaveClass(/swipe-open/);
 await waitForRest(card);
 for(const distance of [40,100]){
  const {dx}=await drag(page,heading,[{dx:distance}],{end:'none'});
  expect(await inlineSwipeX(card),`inline --swipe-x of the open row at dx ${dx}px`).toBe(`${stop+dx}px`);
  await endDrag(page,'cancel');
  const duration=await settleTransitionDuration(card,`settle after the cancel at dx ${dx}px`);
  expect(durationMs(duration),`settle transition-duration ${duration} after the cancel at dx ${dx}px, in ms`).toBeGreaterThan(0);
  await expectSettled(card,true,`after the cancel at dx ${dx}px`);
 }
});

// Requirement 4.6. The first card is open and mid-drag, so when the viewport leaves Touch_Layout it carries .swipe-open,
// .swipe-dragging and an inline --swipe-x at once. The controller's change listener runs in the first rendering update
// after the query stops matching, before that frame's animation frame callbacks, so the reads wait two frames after
// that. The controller also abandons the gesture, so the pointerup that finally ends the drag changes nothing.
test('[TC-SWIPE-018] leaving the touch layout mid-drag closes every row, clears every inline --swipe-x and abandons the gesture',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 const stop=await endStop(card);
 await drag(page,heading,[{dx:-80},{hold:STILL_MS}]);
 await expect(card,'row state after the slow 80px release').toHaveClass(/swipe-open/);
 await waitForRest(card);
 const {dx}=await drag(page,heading,[{dx:40}],{end:'none'});
 expect(await inlineSwipeX(card),`inline --swipe-x of the open row at dx ${dx}px`).toBe(`${stop+dx}px`);
 await page.setViewportSize({width:1440,height:1000});
 await expect.poll(()=>page.evaluate(()=>matchMedia('(max-width: 760px)').matches),'Touch_Layout after the resize to 1440px').toBe(false);
 await frames(page,2);
 const rows=await swipeRowStates(page);
 expect(rows.length,'swipe rows at 1440px').toBeGreaterThan(0);
 expect(rows.filter(({className})=>/(^|\s)swipe-(open|dragging|settling)(\s|$)/.test(className)),'swipe rows still open, dragging or settling at 1440px').toEqual([]);
 expect(rows.filter(({swipeX})=>swipeX!==''),'swipe rows with an inline --swipe-x at 1440px').toEqual([]);
 await endDrag(page);
 expect(await swipeRowStates(page),'swipe rows after the pointerup that ends the abandoned drag').toEqual(rows);
});

// Requirements 6.1, 6.2 and 6.3. The page loads under reduced-motion emulation. One gesture drags the closed first card
// 40px left, where the surface follows the finger 1:1, then on to 200px and 400px, where the rubber band would render
// -155.2px and -184px and the surface holds at the End_Stop of -136px instead. The gesture comes back to 80px before its
// release: a settle from the End_Stop to the open state covers no distance, so it would look the same with an animation,
// while from 80px it has 56px to cover. After a hold the release measures 0 px/ms and the halfway rule opens the row.
// The surface is read one frame after the release, when a running settle would still be far from its end, and the
// transition-duration while .swipe-settling holds. Reduced motion fires no transitionend, so .swipe-settling lasts until
// the controller's 320ms fallback, which expectSettled() waits out. A closing settle from 60px is checked the same way.
test('[TC-SWIPE-019] under reduced motion a drag tracks 1:1, holds at the End_Stop and settles with no animation',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 await openPhoneDemo(page);
 expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),'Reduced_Motion under the emulation').toBe(true);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 const stop=await endStop(card);
 expect(stop,'End_Stop of the two-action first card').toBe(-2*ACTION_WIDTH);
 const linear=await drag(page,heading,[{dx:-40}],{end:'none'});
 expectWithin1px(await surfaceTranslateX(card),linear.dx,`surface translateX at dx ${linear.dx}px`);
 for(const distance of [200,400]){
  const {dx}=await dragMore(page,[{dx:-distance}],{end:'none'});
  const rubberBand=stop-Math.min(RUBBER_MAX,RUBBER_RESIST*(stop-dx));
  expectWithin1px(await surfaceTranslateX(card),stop,`surface translateX at dx ${dx}px, where the rubber band would render ${rubberBand}px`);
 }
 const back=await dragMore(page,[{dx:-80}],{end:'none'});
 expectWithin1px(await surfaceTranslateX(card),back.dx,`surface translateX back at dx ${back.dx}px`);
 const opening=await dragMore(page,[{hold:STILL_MS}],{frames:1});
 expectWithin1px(await surfaceTranslateX(card),stop,'surface translateX one frame after the opening release');
 expect(measuredReleaseVelocity(opening),'release velocity after the hold at 80px, px/ms').toBe(0);
 expect(await settleTransitionDuration(card,'opening settle'),'opening settle transition-duration').toBe('0s');
 await expectSettled(card,true,'after the opening release');
 // From the open row, 76px rightward leaves the surface 60px from closed, short of halfway.
 const closing=await drag(page,heading,[{dx:76},{hold:STILL_MS}],{frames:1});
 expectWithin1px(await surfaceTranslateX(card),0,'surface translateX one frame after the closing release');
 expect(measuredReleaseVelocity(closing),'release velocity after the hold 60px from closed, px/ms').toBe(0);
 expect(await settleTransitionDuration(card,'closing settle'),'closing settle transition-duration').toBe('0s');
 await expectSettled(card,false,'after the closing release');
});

// Requirement 6.4. The controller reads the preference on every pointermove, and the settle reads it through the
// cascade, so a change between gestures applies from the next gesture on. Three gestures on one page drag the closed
// first card 200px left and then cancel. Under no preference the surface renders the rubber band, 0.3 × 64 = 19.2px past
// the End_Stop at -155.2px, and the cancel settles over the swipe block's 0.26s. Under reduce the surface holds at the
// End_Stop of -136px and the settle's transition-duration is 0s. Back under no preference both return. A reload would
// start a new document with a new performance.timeOrigin, so an unchanged timeOrigin shows the page never reloaded.
test('[TC-SWIPE-020] a reduced-motion preference change applies to the next gesture with no reload',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 const stop=await endStop(card);
 const timeOrigin=await page.evaluate(()=>performance.timeOrigin);
 for(const [index,reducedMotion] of ['no-preference','reduce','no-preference'].entries()){
  const reduced=reducedMotion==='reduce',what=`gesture ${index+1}, under ${reducedMotion}`;
  await page.emulateMedia({reducedMotion});
  expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),`${what}: Reduced_Motion`).toBe(reduced);
  const {dx}=await drag(page,heading,[{dx:-200}],{end:'none'});
  const expected=reduced?stop:stop-Math.min(RUBBER_MAX,RUBBER_RESIST*(stop-dx));
  expectWithin1px(await surfaceTranslateX(card),expected,`${what}: surface translateX at dx ${dx}px`);
  await endDrag(page,'cancel');
  expect(await settleTransitionDuration(card,`${what}: settle after the cancel`),`${what}: settle transition-duration`).toBe(reduced?'0s':'0.26s');
  await expectSettled(card,false,`${what}: after the cancel`);
 }
 expect(await page.evaluate(()=>performance.timeOrigin),'performance.timeOrigin after the three gestures, against the one before them').toBe(timeOrigin);
});

// ---------------------------------------------------------------------------------------------------------
// Preserved markup and dismissal contracts (task 6.7): helpers, then tests.
// ---------------------------------------------------------------------------------------------------------

// A gesture that ends after CLICK_SUPPRESS_DISTANCE px of horizontal travel or more swallows the next click that comes
// within CLICK_SUPPRESS_MS ms. The same constants as the controller's LEGACY_CLOSE and CLICK_SUPPRESS_MS.
const CLICK_SUPPRESS_DISTANCE=42;
const CLICK_SUPPRESS_MS=450;

/** Open a section tab of the trip page, as tests/app.e2e.js does. */
const nav=(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();

/** Whether a swipeRowStates() entry is a row in the open state. */
const isOpen=({className})=>/(^|\s)swipe-open(\s|$)/.test(className);

/**
 * In-page: what prepare() built in `row`. The originals are the row's buttons outside its panel, apart from the toggle,
 * in document order, which is the order prepare() clones them in, so clones[i] copies originals[i]. `action` is a
 * button's data-action, or its data-xp on a ledger button. A clone's child nodes are listed by nodeName, so a text node
 * shows as '#text'.
 */
function readPreparedRow(row){
 const children=[...row.children],panels=children.filter(el=>el.matches('.swipe-actions'));
 const action=el=>el.dataset.action??el.dataset.xp??null;
 return {
  swipeCount:row.style.getPropertyValue('--swipe-count').trim(),
  panels:panels.map(el=>({role:el.getAttribute('role'),ariaLabel:el.getAttribute('aria-label'),ariaHidden:el.getAttribute('aria-hidden')})),
  clones:[...(panels[0]?.children??[])].map(el=>({tag:el.tagName.toLowerCase(),action:action(el),label:el.dataset.swipeLabel??null,swipeAction:el.classList.contains('swipe-action'),danger:el.classList.contains('swipe-action-danger'),id:el.getAttribute('id'),ariaLabel:el.getAttribute('aria-label'),childNodes:[...el.childNodes].map(node=>node.nodeName.toLowerCase())})),
  originals:[...row.querySelectorAll('button')].filter(el=>!el.closest('.swipe-actions')&&!el.matches('.swipe-toggle')).map(el=>({action:action(el),id:el.getAttribute('id'),text:el.textContent.trim(),ariaLabel:el.getAttribute('aria-label'),swipeOriginal:el.getAttribute('data-swipe-original'),icons:el.querySelectorAll('svg').length})),
  toggles:children.filter(el=>el.matches('.swipe-toggle')).map(el=>({tag:el.tagName.toLowerCase(),ariaLabel:el.getAttribute('aria-label'),ariaExpanded:el.getAttribute('aria-expanded'),text:el.textContent}))
 };
}

/**
 * Assert the clone conventions of Requirement 5.4 on a readPreparedRow() result of a row at rest: one hidden panel, one
 * collapsed toggle, and a clone of each original, in order, with `labels` as their data-swipe-label. A clone is a
 * button with the swipe-action class, and swipe-action-danger too when it deletes, with no id, the aria-label of its
 * original, and the svg icons of its original as its only children. `what` names the row in failure messages.
 */
function expectCloneConventions({swipeCount,panels,clones,originals,toggles},what,labels){
 expect(panels,`${what}: .swipe-actions panels`).toEqual([{role:'group',ariaLabel:'滑動操作',ariaHidden:'true'}]);
 expect(clones.map(({action})=>action),`${what}: action of each clone, against that of each original`).toEqual(originals.map(({action})=>action));
 expect(clones.map(({label})=>label),`${what}: data-swipe-label of each clone`).toEqual(labels);
 for(const [index,clone] of clones.entries()){
  const original=originals[index],name=`${what}, clone ${index+1} (${clone.label})`;
  expect(clone.tag,`${name}: element`).toBe('button');
  expect(clone.swipeAction,`${name}: swipe-action class`).toBe(true);
  // Only a delete clone is styled as a destructive action.
  expect(clone.danger,`${name}: swipe-action-danger class`).toBe(clone.label==='刪除');
  expect(clone.id,`${name}: id attribute, where its original has ${original.id===null?'none':`id="${original.id}"`}`).toBe(null);
  expect(original.ariaLabel,`${name}: aria-label of its original`).not.toBe(null);
  expect(clone.ariaLabel,`${name}: aria-label, against that of its original`).toBe(original.ariaLabel);
  expect(clone.childNodes,`${name}: child nodes, where its original holds ${original.icons} svg icon(s)${original.text?` and the text "${original.text}"`:''}`).toEqual(Array(original.icons).fill('svg'));
  expect(original.swipeOriginal,`${name}: data-swipe-original of its original`).toBe('true');
 }
 expect(swipeCount,`${what}: inline --swipe-count, against its clone count`).toBe(String(clones.length));
 expect(toggles,`${what}: .swipe-toggle buttons`).toEqual([{tag:'button',ariaLabel:'顯示編輯與刪除操作',ariaExpanded:'false',text:'‹'}]);
}

/**
 * Every opt-in [data-swipe-row] on the page, in document order, as {index,tag,prepared,panels,toggles}: its tag and
 * class attribute, whether prepare() made it a .swipe-row with data-swipe-ready="true", and how many .swipe-actions
 * panels and .swipe-toggle buttons it holds.
 */
const optInRows=page=>page.evaluate(()=>[...document.querySelectorAll('[data-swipe-row]')].map((row,index)=>({index,tag:`${row.tagName.toLowerCase()} class="${row.getAttribute('class')??''}"`,prepared:row.classList.contains('swipe-row')&&row.dataset.swipeReady==='true',panels:row.querySelectorAll('.swipe-actions').length,toggles:row.querySelectorAll('.swipe-toggle').length})));

/**
 * Assert that every opt-in row on the page is prepared exactly once: a .swipe-row that holds one .swipe-actions panel
 * and one .swipe-toggle. Only for pages where every opt-in row has an enabled action, as on the demo's schedule and
 * meals tabs. Member and vehicle cards now live in the trip menu drawer and carry no data-swipe-row, so they are never
 * opt-in rows. The
 * read waits a frame first, so the MutationObserver has handled the last render. `what` names the step in failure
 * messages.
 */
async function expectOnePanelPerRow(page,what){
 await frames(page,1);
 const rows=await optInRows(page);
 expect(rows.length,`${what}: opt-in rows on the page`).toBeGreaterThan(0);
 expect(rows.filter(({prepared,panels,toggles})=>!prepared||panels!==1||toggles!==1),`${what}: rows without exactly one panel and one toggle`).toEqual([]);
}

/**
 * In-page: start recording every click the window sees. A capture listener on window logs each click before any page
 * listener runs, and a bubble listener on the document marks the clicks that got that far. The controller's click
 * listener is a capture listener on document.body, so a click it swallows never reaches the bubble listener.
 */
function startClickLog(){
 const KEY='__mobileSwipeE2eClickLog';
 if(window[KEY])throw new Error('a click log is already recording');
 const log={entries:[]};
 log.capture=event=>log.entries.push({event,t:performance.now(),bubbled:false});
 log.bubble=event=>{const entry=log.entries.find(item=>item.event===event);if(entry)entry.bubbled=true;};
 window.addEventListener('click',log.capture,true);
 document.addEventListener('click',log.bubble);
 window[KEY]=log;
}

/**
 * In-page: the clicks recorded since startClickLog(), oldest first, as {t,bubbled,defaultPrevented}: t is the page's
 * performance.now() when the click reached window, bubbled whether the document's bubble listener saw it, and
 * defaultPrevented whether a listener called preventDefault, read now that the dispatch has finished. With `stop` true,
 * recording ends.
 */
function readClickLog(stop){
 const KEY='__mobileSwipeE2eClickLog',log=window[KEY];
 if(!log)throw new Error('no click log is recording');
 if(stop){
  window.removeEventListener('click',log.capture,true);
  document.removeEventListener('click',log.bubble);
  delete window[KEY];
 }
 return log.entries.map(({event,t,bubbled})=>({t,bubbled,defaultPrevented:event.defaultPrevented}));
}

// Requirement 5.4. The allowlisted controls of the first card are the edit and delete buttons in its .activity-top, so
// prepare() gives it a two-button panel and a toggle, and marks both originals, which the touch layout hides. The
// clones keep the data-action of their originals, which is how the app's click handler acts on them.
// Those originals hold an svg icon and nothing else, and no id, so a prepare() that left text or ids on its clones
// would still pass on them. The ledger rows of src/expenses-ui.js would not: the edit and delete buttons of an expense
// carry ids, and the delete button of a settlement is text only. Ledger rows need an account, so the test appends one
// expense row and one settlement row to the timeline, with buttons that copy the ledger's markup, icon paths aside.
test('[TC-SWIPE-021] a prepared row clones its enabled actions into the panel with the swipe-action conventions',async({page})=>{
 await openPhoneDemo(page);
 const card=await page.locator('.activity-card').first().evaluate(readPreparedRow);
 expect(card.originals.map(({action})=>action),'the first card: data-action of each original').toEqual(['activity','delete']);
 expectCloneConventions(card,'the first card',['編輯','刪除']);
 await page.locator('.timeline').evaluate(timeline=>{
  const icon=path=>`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  timeline.insertAdjacentHTML('beforeend',`<ul class="xp-rows"><li class="xp-row" data-swipe-row data-e2e-row="expense"><div class="xp-row-main"><b class="xp-row-title">晚餐食材</b></div><div class="xp-row-actions"><button type="button" class="icon-button" data-xp="edit-expense" id="e2e-edit-x1" data-xp-id="x1" aria-label="編輯 晚餐食材" title="編輯支出">${icon('M4 20h4L20 8l-4-4L4 16z')}</button><button type="button" class="icon-button danger" data-xp="ask-remove-expense" id="e2e-del-x1" data-xp-id="x1" aria-label="移除 晚餐食材" title="移除 晚餐食材">${icon('M6 6l12 12M18 6 6 18')}</button></div></li><li class="xp-row" data-swipe-row data-e2e-row="settlement"><div class="xp-row-main"><b class="xp-row-title">小安 → 阿哲</b></div><div class="xp-row-actions"><button type="button" class="button small quiet danger" data-xp="ask-remove-settlement" id="e2e-sdel-s1" data-xp-id="s1" aria-label="移除 小安 給 阿哲 的還款紀錄">移除</button></div></li></ul>`);
 });
 await frames(page,2);
 expectCloneConventions(await page.locator('[data-e2e-row="expense"]').evaluate(readPreparedRow),'the expense row',['編輯','刪除']);
 expectCloneConventions(await page.locator('[data-e2e-row="settlement"]').evaluate(readPreparedRow),'the settlement row',['刪除']);
});

// Requirement 5.5. render() in src/app.js rebuilds the page through app.innerHTML on every change, so each step below
// renders fresh rows that the MutationObserver has to prepare once each: adding an activity through the 新增一站
// dialog, as tests/app.e2e.js does (on /demo/ the new activity stays in this context's localStorage), ticking a
// completion box, leaving the schedule tab and coming back, and changing the day and changing it back. The demo's
// first day has five activities, so six once the new one is added.
// Those steps never hand the observer a row it has already prepared. render() can: it re-appends the one element it
// keeps between renders, the expense panel, with its rows, and the data-swipe-ready guard keeps prepare() from cloning
// their actions a second time. Expense rows need an account, so the last step re-inserts a prepared card in place, the
// way that append moves them.
test('[TC-SWIPE-022] every row a re-render adds gets one panel and one toggle, and a re-inserted row gets no second panel',async({page})=>{
 await openPhoneDemo(page);
 await expectOnePanelPerRow(page,'after the first render');
 await page.getByRole('button',{name:'新增一站',exact:true}).click();
 await page.getByLabel('活動名稱').fill('測試野餐');
 await page.getByLabel('時間',{exact:true}).fill('13:20');
 await page.getByLabel('地點',{exact:true}).fill('樹下');
 await page.locator('#edit-form button[type="submit"]').click();
 const title=page.getByRole('heading',{name:'測試野餐',exact:true});
 await expect(title,'heading of the added activity').toBeVisible();
 const added=page.locator('.activity-card').filter({has:title});
 await expect(added.locator('.swipe-actions'),'.swipe-actions panels of the added activity').toHaveCount(1);
 await expect(added.locator('.swipe-toggle'),'.swipe-toggle buttons of the added activity').toHaveCount(1);
 await expectOnePanelPerRow(page,'after adding the activity');
 const done=page.getByRole('checkbox',{name:'城市集合，把日常暫停已完成',exact:true});
 await done.click();
 await expect(done,'completion box of 城市集合，把日常暫停 after the click').toBeChecked();
 await expectOnePanelPerRow(page,'after ticking the completion box');
 await nav(page,'meals');
 await expect(page.getByRole('heading',{name:'一起煮，一起吃',exact:true}),'heading of the meals tab').toBeVisible();
 await expectOnePanelPerRow(page,'on the meals tab');
 await nav(page,'schedule');
 await expect(page.locator('.activity-card'),'activity cards back on the schedule tab').toHaveCount(6);
 await expectOnePanelPerRow(page,'back on the schedule tab');
 await page.locator('[data-day="2026-11-21"]').click();
 await expect(page.locator('.activity-card'),'activity cards on 2026-11-21').toHaveCount(3);
 await expectOnePanelPerRow(page,'on 2026-11-21');
 await page.locator('[data-day="2026-11-20"]').click();
 await expect(page.locator('.activity-card'),'activity cards back on 2026-11-20').toHaveCount(6);
 await expectOnePanelPerRow(page,'back on 2026-11-20');
 await page.locator('.activity-card').first().evaluate(row=>row.parentElement.insertBefore(row,row.nextSibling));
 await expectOnePanelPerRow(page,'after re-inserting a prepared card');
});

// Requirement 5.6, on the first two cards. A click on the toggle of row A opens A, and a click on the toggle of row B
// opens B and closes A. The toggle of an open row is display:none (.swipe-row.swipe-open>.swipe-toggle), so no user can
// reach it and click() could not either. The last step dispatches the click on the hidden toggle of row B instead, to
// check the inversion from open that onClick implements, a path only script can take.
test('[TC-SWIPE-023] a toggle click closes the other rows and inverts the state of its own row',async({page})=>{
 await openPhoneDemo(page);
 const cards=page.locator('.activity-card'),rowA=cards.nth(0),rowB=cards.nth(1);
 const openRows=async()=>(await swipeRowStates(page)).filter(isOpen).length;
 await rowA.locator('.swipe-toggle').click();
 await expectSettled(rowA,true,'row A after a click on its toggle');
 await expectSettled(rowB,false,'row B after a click on the toggle of row A');
 await rowB.locator('.swipe-toggle').click();
 await expectSettled(rowB,true,'row B after a click on its toggle');
 await expectSettled(rowA,false,'row A after a click on the toggle of row B');
 expect(await openRows(),'open rows after the click on the toggle of row B').toBe(1);
 await expect(rowB.locator('.swipe-toggle'),'display of the toggle of row B while row B is open').toHaveCSS('display','none');
 await rowB.locator('.swipe-toggle').dispatchEvent('click');
 await expectSettled(rowB,false,'row B after a click dispatched on its hidden toggle');
 expect(await openRows(),'open rows after the dispatched click').toBe(0);
});

// Requirement 5.7. .schedule-intro is the caption above the day's timeline. It lies outside every panel, and no app
// listener acts on a click there.
test('[TC-SWIPE-024] a click outside every panel closes the open row',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 await card.locator('.swipe-toggle').click();
 await expectSettled(card,true,'after a click on the toggle');
 await page.locator('.schedule-intro').click();
 expect((await swipeRowStates(page)).filter(isOpen),'rows still open after a click on .schedule-intro').toEqual([]);
 await expectSettled(card,false,'after a click on .schedule-intro');
});

// Requirement 2.9. Playwright's click() sends a mouse pointerdown first, and onPointerDown clears the suppression
// window before it checks the pointer type, so a click() is never swallowed. These clicks are dispatched straight onto
// the card's h3 with no pointerdown before them. The 80px slow release opens the row by the halfway rule, so a first
// click that got through would also close the row again.
test('[TC-SWIPE-025] a swipe of at least 42px swallows the next click within 450ms and only that one',async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first(),heading=card.locator('h3');
 await page.evaluate(startClickLog);
 const swipe=await drag(page,heading,[{dx:-80},{hold:STILL_MS}]);
 expect(Math.abs(swipe.dx),'horizontal travel of the swipe, px').toBeGreaterThanOrEqual(CLICK_SUPPRESS_DISTANCE);
 await expect(card,'row state after the swipe').toHaveClass(/swipe-open/);
 await heading.dispatchEvent('click');
 const [swallowed]=await page.evaluate(readClickLog,false);
 expect(swallowed.t-swipe.release.t,'ms from the release to the first click').toBeLessThan(CLICK_SUPPRESS_MS);
 expect(swallowed.bubbled,'the first click reached the bubble listener on the document').toBe(false);
 expect(swallowed.defaultPrevented,'defaultPrevented of the first click').toBe(true);
 await expect(card,'row state after the swallowed click').toHaveClass(/swipe-open/);
 // One swallowed click closes the window, so the next click goes through although it is still inside the 450ms.
 await heading.dispatchEvent('click');
 const [,passed]=await page.evaluate(readClickLog,true);
 expect(passed.t-swipe.release.t,'ms from the release to the second click').toBeLessThan(CLICK_SUPPRESS_MS);
 expect(passed.bubbled,'the second click reached the bubble listener on the document').toBe(true);
 expect(passed.defaultPrevented,'defaultPrevented of the second click').toBe(false);
 test.info().annotations.push({type:'clicks after a swipe',description:`swipe of ${swipe.dx}px; the first click came ${(swallowed.t-swipe.release.t).toFixed(1)}ms after the release and was swallowed, the second came ${(passed.t-swipe.release.t).toFixed(1)}ms after the release and went through`});
 // The click that went through landed outside every panel, so it closed the row.
 await expectSettled(card,false,'after the second click');
});

// Requirement 2.9, the other side. A tap is a pointerdown and a pointerup at one point with no move, so it travels 0px,
// never resolves an axis and opens no suppression window: the click that follows it within 450ms goes through.
test('[TC-SWIPE-026] a tap with no travel swallows no click',async({page})=>{
 await openPhoneDemo(page);
 const heading=page.locator('.activity-card').first().locator('h3');
 await page.evaluate(startClickLog);
 const tap=await drag(page,heading,[]);
 expect({moves:tap.samples.length,dx:tap.dx,dy:tap.dy},'pointermoves and travel of the tap').toEqual({moves:0,dx:0,dy:0});
 await heading.dispatchEvent('click');
 const [click]=await page.evaluate(readClickLog,true);
 expect(click.t-tap.release.t,'ms from the release of the tap to the click').toBeLessThan(CLICK_SUPPRESS_MS);
 expect(click.bubbled,'the click reached the bubble listener on the document').toBe(true);
 expect(click.defaultPrevented,'defaultPrevented of the click').toBe(false);
 test.info().annotations.push({type:'click after a tap',description:`the click came ${(click.t-tap.release.t).toFixed(1)}ms after the release of the tap and went through`});
});

// Requirement 5.9. No row in the demo has only disabled actions, so the test appends two rows to the timeline: one
// whose allowlisted edit and delete buttons are disabled, and a control with the same buttons enabled, which shows
// that the MutationObserver scanned the insertion.
test('[TC-SWIPE-027] a row whose allowlisted actions are all disabled gets no panel and no toggle',async({page})=>{
 await openPhoneDemo(page);
 await page.locator('.timeline').evaluate(timeline=>{
  const row=disabled=>`<article data-swipe-row data-e2e-row="${disabled?'disabled':'enabled'}"><h3>測試列</h3><button type="button" data-action="activity" aria-label="編輯 測試列"${disabled?' disabled':''}>編輯</button><button type="button" data-action="delete" aria-label="移除 測試列"${disabled?' disabled':''}>移除</button></article>`;
  timeline.insertAdjacentHTML('beforeend',row(true)+row(false));
 });
 await frames(page,2);
 const state=row=>row.evaluate(el=>({swipeRow:el.classList.contains('swipe-row'),swipeReady:el.getAttribute('data-swipe-ready'),panels:el.querySelectorAll('.swipe-actions').length,clones:el.querySelectorAll('.swipe-action').length,toggles:el.querySelectorAll('.swipe-toggle').length}));
 expect(await state(page.locator('[data-e2e-row="enabled"]')),'the control row, with the same buttons enabled').toEqual({swipeRow:true,swipeReady:'true',panels:1,clones:2,toggles:1});
 expect(await state(page.locator('[data-e2e-row="disabled"]')),'the row with only disabled buttons').toEqual({swipeRow:false,swipeReady:null,panels:0,clones:0,toggles:0});
});

// ---------------------------------------------------------------------------------------------------------
// A release after a pause (task 6.9): helpers, then tests.
// ---------------------------------------------------------------------------------------------------------

// The pause before each release, in ms. It exceeds VELOCITY_WINDOW, so the window that ends at the release holds no
// pointermove. Task 4.5 checked the same two drags with pauses of about 200ms.
const PAUSE_MS=200;

/**
 * The velocity in px/ms, negative leftward, that the pointermoves of a drag() result show by themselves: the slope
 * from the earliest sample in the VELOCITY_WINDOW ms that end at the last move to the last move. That is how the
 * controller measured a release before task 4.5 counted the release as a sample. null with fewer than two moves or a
 * window of no width.
 */
function moveVelocity({samples}){
 const last=samples.at(-1);
 if(!last)return null;
 const first=samples.find(sample=>last.t-sample.t<=VELOCITY_WINDOW),dt=last.t-first.t;
 return dt>0?(last.x-first.x)/dt:null;
}

/**
 * Drag `row`, the closed first activity card, `distance` px left in three frames, pause PAUSE_MS, and release straight
 * after the pause. Then assert what makes it a pause test. The row's End_Stop is -136px, so halfway is 68px. The moves
 * alone measured a leftward flick, so the rule from before task 4.5 would open the row at any distance. The release
 * came more than VELOCITY_WINDOW ms after the last move and measured 0 px/ms, so the halfway rule decides. The
 * measured values are recorded as a 'release after a pause' annotation. Resolves to the drag() result.
 */
async function releaseAfterPause(page,row,distance){
 expect(await endStop(row),'End_Stop of the two-action first card').toBe(-2*ACTION_WIDTH);
 const result=await drag(page,row.locator('h3'),[{dx:-distance,steps:3},{pause:PAUSE_MS}],{release:'immediate'});
 const moves=moveVelocity(result),gap=result.release.t-result.samples.at(-1).t,released=measuredReleaseVelocity(result);
 test.info().annotations.push({type:'release after a pause',description:`${distance}px in ${result.samples.length} moves, which alone measured ${moves===null?'no velocity':`${moves.toFixed(3)}px/ms`}; the release came ${gap.toFixed(1)}ms after the last move and measured ${released}px/ms`});
 expect(moves,`velocity of the moves alone in the ${distance}px drag, px/ms`).toBeLessThanOrEqual(-FLICK_THRESHOLD);
 expect(gap,`ms from the last move of the ${distance}px drag to its release`).toBeGreaterThan(VELOCITY_WINDOW);
 expect(released,`release velocity of the ${distance}px drag after the pause, px/ms`).toBe(0);
 return result;
}

// Requirements 2.4 and 2.11. 40px is short of halfway, so the row settles closed only because the pause zeroes the
// release velocity. Measured back from the last move, as before task 4.5, the same release flicks the row open.
test(`a fast 40px drag released after a ${PAUSE_MS}ms pause settles closed`,async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 await releaseAfterPause(page,card,40);
 await expectSettled(card,false,'after the 40px drag, pause and release');
});

// Requirements 2.3 and 2.11. 100px is past halfway, so the halfway rule opens the row after the pause.
test(`a fast 100px drag released after a ${PAUSE_MS}ms pause settles open`,async({page})=>{
 await openPhoneDemo(page);
 const card=page.locator('.activity-card').first();
 await releaseAfterPause(page,card,100);
 await expectSettled(card,true,'after the 100px drag, pause and release');
});
