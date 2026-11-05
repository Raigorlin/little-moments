import {test,expect} from 'bun:test';
import {googleMapsUrl,mapLink} from '../src/maps.js';
test('Google Maps search encodes real address as query on fixed origin',()=>{
 const address='台北車站',url=new URL(googleMapsUrl(address));
 expect(url.origin).toBe('https://www.google.com');expect(url.pathname).toBe('/maps/search/');expect(url.searchParams.get('api')).toBe('1');expect(url.searchParams.get('query')).toBe(address);
});
test('injected URL, delimiters and quotes cannot replace destination or markup',()=>{
 for(const text of ['javascript:alert(1)','https://evil.example/?q=x&foo=1','<img src=x onerror=alert(1)>','A & B "C"']){
  expect(new URL(googleMapsUrl(text)).origin).toBe('https://www.google.com');expect(new URL(googleMapsUrl(text)).searchParams.get('query')).toBe(text);
  expect(mapLink(text)).not.toContain('<img');expect(mapLink(text)).toContain('rel="noopener noreferrer"');expect(mapLink(text)).toContain('target="_blank"');
 }
});
test('blank and very long legacy addresses stay readable without invalid URLs',()=>{
 expect(googleMapsUrl(' ')).toBe('');expect(mapLink('')).toBe('地點待確認');const text='地'.repeat(1000);expect(googleMapsUrl(text)).toBe('');expect(mapLink(text)).toBe(text);
});
test('vehicle meeting label can keep original time but search only location',()=>{
 const html=mapLink('台北車站',{label:'09:00 · 台北車站'});expect(html).toContain('09:00 · 台北車站');expect(html).not.toContain('query=09');
});
