import {test,expect} from 'bun:test';
import {DAILY_NOTES,dailyNote,nextTaipeiMidnight,setupDailyNote} from '../src/daily-notes.js';
test('60 original, unique plain-text notes fit a small card',()=>{
 expect(DAILY_NOTES).toHaveLength(60);expect(new Set(DAILY_NOTES).size).toBe(60);expect(Object.isFrozen(DAILY_NOTES)).toBe(true);
 for(const note of DAILY_NOTES){expect(note.length).toBeGreaterThan(10);expect(note.length).toBeLessThanOrEqual(40);expect(note).not.toMatch(/[<>]/);}
});
test('same Taiwan calendar day always has the same note regardless of timestamp zone',()=>{
 const a=dailyNote(new Date('2026-11-03T16:00:00Z')),b=dailyNote(new Date('2026-11-04T23:59:59+08:00'));
 expect(a).toEqual(b);expect(a.date).toBe('2026-11-04');
});
test('Taipei midnight advances to the next note',()=>{
 const a=dailyNote(new Date('2026-11-04T15:59:59.999Z')),b=dailyNote(new Date('2026-11-04T16:00:00Z'));
 expect(b.date).toBe('2026-11-05');expect(b.index).toBe((a.index+1)%60);expect(a.text).not.toBe(b.text);
 expect(nextTaipeiMidnight(new Date('2026-11-04T15:59:59.999Z'))).toBe(Date.parse('2026-11-04T16:00:00Z'));
});
test('all 60 notes appear before a repeat, including negative epoch days',()=>{
 const start=Date.parse('2026-01-01T00:00:00+08:00'),notes=Array.from({length:60},(_,i)=>dailyNote(new Date(start+i*86400000)).text);
 expect(new Set(notes).size).toBe(60);expect(dailyNote(new Date(start+60*86400000)).text).toBe(notes[0]);
 expect(dailyNote(new Date('1960-01-01')).text).toBeTruthy();expect(()=>dailyNote(new Date('invalid'))).toThrow(RangeError);
});
test('year-end and leap-day boundaries remain correct',()=>{
 for(const [from,to] of [['2026-12-31T23:59:59+08:00','2027-01-01'],['2028-02-28T23:59:59+08:00','2028-02-29'],['2028-02-29T23:59:59+08:00','2028-03-01']]){
  expect(dailyNote(new Date(nextTaipeiMidnight(new Date(from)))).date).toBe(to);
 }
});
test('refresh updates only note nodes at midnight or wake, schedules once and cleans up',()=>{
 let current=new Date('2026-11-04T15:59:59Z'),callback,delay;const events={},cleared=[];
 const quote={textContent:''},date={textContent:'',setAttribute(k,v){this[k]=v;}};
 const doc={visibilityState:'visible',querySelectorAll:s=>s==='[data-daily-quote]'?[quote]:[date],addEventListener:(k,f)=>events[k]=f,removeEventListener:k=>delete events[k],defaultView:{addEventListener:(k,f)=>events[k]=f,removeEventListener:k=>delete events[k]}};
 const stop=setupDailyNote({document:doc,now:()=>current,setTimer:(f,d)=>{callback=f;delay=d;return 7;},clearTimer:id=>cleared.push(id)});
 const original=quote.textContent;expect(date.datetime).toBe('2026-11-04');expect(delay).toBe(1050);
 current=new Date('2026-11-04T16:00:00.050Z');callback();expect(date.datetime).toBe('2026-11-05');expect(quote.textContent).not.toBe(original);
 current=new Date('2026-11-06T00:00:00+08:00');events.visibilitychange();expect(date.textContent).toBe('11/06');expect(delay).toBe(86400050);
 stop();expect(Object.keys(events)).toEqual([]);expect(cleared.at(-1)).toBe(7);
});
