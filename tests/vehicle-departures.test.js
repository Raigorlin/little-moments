import {describe,test,expect} from 'bun:test';
import {parseVehicleMeeting,formatVehicleMeeting,vehicleDepartures} from '../src/vehicle-departures.js';
import {seed,isValidState} from '../src/model.js';

describe('vehicle departure compatibility',()=>{
 test('reads existing meeting format without modifying it',()=>{
  expect(parseVehicleMeeting('14:00 · 台北車站東三門')).toEqual({time:'14:00',location:'台北車站東三門'});
  for(const separator of ['·','・','|','｜'])expect(parseVehicleMeeting(`08:05 ${separator} 台中高鐵站`)).toEqual({time:'08:05',location:'台中高鐵站'});
 });
 test('keeps unstructured and invalid time strings intact as location',()=>{
  for(const value of ['早上八點在家門口','9:00 台北車站','24:00 · 車站','12:60 · 車站','台北車站 · 東三門'])expect(parseVehicleMeeting(value)).toEqual({time:'',location:value});
 });
 test('handles time-only, empty and multiline data',()=>{
  expect(parseVehicleMeeting('00:00')).toEqual({time:'00:00',location:''});
  expect(parseVehicleMeeting()).toEqual({time:'',location:''});
  expect(parseVehicleMeeting('23:59 · 車站\n東三門')).toEqual({time:'23:59',location:'車站\n東三門'});
 });
 test('round-trips untouched legacy text byte-for-byte',()=>{
  for(const original of [' 14:00｜台北車站  ','台北車站（9點後再聯絡）','08:00 · 車站\n東三門','']){
   const {time,location}=parseVehicleMeeting(original);expect(formatVehicleMeeting(time,location,original)).toBe(original);
  }
 });
 test('writes the existing schema rather than adding new required fields',()=>{
  const state=seed();state.vehicles[0].meeting=formatVehicleMeeting('08:30',' 台北車站 ');
  expect(state.vehicles[0].meeting).toBe('08:30 · 台北車站');expect(isValidState(state)).toBe(true);
  expect(state.vehicles[0]).not.toHaveProperty('departTime');expect(state.vehicles[0]).not.toHaveProperty('departLocation');
 });
 test('location can be saved without a guessed time',()=>expect(formatVehicleMeeting('','台中高鐵站')).toBe('台中高鐵站'));
 test('rejects invalid time, blank location and excess combined length',()=>{
  for(const time of ['8:00','24:00','12:60','word'])expect(()=>formatVehicleMeeting(time,'台北')).toThrow('有效');
  expect(()=>formatVehicleMeeting('08:00',' ')).toThrow('地點');
  expect(formatVehicleMeeting('08:00','地'.repeat(142))).toHaveLength(150);
  expect(()=>formatVehicleMeeting('08:00','地'.repeat(143))).toThrow('150');
 });
 test('untouched long legacy text is preserved but edits respect the limit',()=>{
  const original='長'.repeat(160);expect(formatVehicleMeeting('',original,original)).toBe(original);
  expect(()=>formatVehicleMeeting('',original+'改',original)).toThrow('150');
 });
 test('sorts first-day cars by departure time with unknown times last and stable ties',()=>{
  const state=seed();state.vehicles=[{id:'unknown',meeting:'時間待定'},{id:'later',meeting:'09:00 · 台北'},{id:'early',meeting:'07:30 · 台中'},{id:'tie',meeting:'09:00 · 桃園'}];
  const before=structuredClone(state);expect(vehicleDepartures(state,state.trip.startDate).map(x=>x.vehicle.id)).toEqual(['early','later','tie','unknown']);expect(state).toEqual(before);
 });
 test('other days and empty fleets do not invent departures',()=>{
  const state=seed();expect(vehicleDepartures(state,'2026-11-21')).toEqual([]);state.vehicles=[];expect(vehicleDepartures(state,state.trip.startDate)).toEqual([]);
 });
});
