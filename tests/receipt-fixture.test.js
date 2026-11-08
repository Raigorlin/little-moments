import {test,expect} from 'bun:test';
import {googleMapsUrl} from '../src/maps.js';
import {readFileSync} from 'node:fs';

test('Google Maps links only use explicit link navigation, no geolocation or API key',()=>{
 const source=readFileSync(new URL('../src/maps.js',import.meta.url),'utf8');
 expect(source).not.toMatch(/fetch\(|geolocation|apiKey|window\.open/);
 expect(new URL(googleMapsUrl('台北車站')).searchParams.get('query')).toBe('台北車站');
});
