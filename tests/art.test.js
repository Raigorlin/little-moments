import {test,expect} from 'bun:test';
import {illustration} from '../src/art.js';

test('cover illustration choices render distinct, complete SVG scenes',()=>{
 for(const kind of ['camp','travel','lake','forest','beach','sunrise','night']){
  const markup=illustration(kind);
  expect(markup.startsWith('<svg')).toBe(true);
  expect(markup).toContain(`illustration--${kind}`);
  expect(markup).toContain('</svg>');
 }
});
