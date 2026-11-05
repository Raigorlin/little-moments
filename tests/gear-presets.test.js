import {test,expect} from 'bun:test';
import {PERSONAL_GEAR_GROUPS,PERSONAL_GEAR_PRESETS,personalGearPreset} from '../src/gear-presets.js';

test('camping essentials are grouped, uniquely named, and have valid suggested quantities',()=>{
 const names=PERSONAL_GEAR_PRESETS.map(item=>item.name);
 expect(PERSONAL_GEAR_GROUPS.map(group=>group.label)).toEqual(['睡眠與遮蔽','穿著與盥洗','隨身用品']);
 expect(new Set(names).size).toBe(names.length);
 for(const name of ['帳篷','行軍床','折疊床','充氣床墊','棉被','睡袋','水壺'])expect(names).toContain(name);
 for(const item of PERSONAL_GEAR_PRESETS){expect(item.name.length).toBeLessThanOrEqual(100);expect(item.quantity.length).toBeLessThanOrEqual(40);expect(item.quantity).toMatch(/^1 /);expect(personalGearPreset(item.name)).toBe(item);}
 expect(personalGearPreset('<img>')).toBeNull();expect(personalGearPreset('')).toBeNull();
});
