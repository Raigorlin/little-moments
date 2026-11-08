import {describe,test,expect} from 'bun:test';
import {dishIllustration,DISH_KINDS} from '../src/dish-art.js';

const KINDS=['hotpot','bbq','toast','curry','pasta','breakfast','salad','custom'];
const svgOf=html=>html.slice(html.indexOf('<svg'),html.lastIndexOf('</svg>')+6);
const wrapperAttr=(html,name)=>html.match(new RegExp(`^<span[^>]*\\s${name}="([^"]*)"`))?.[1];
const tags=html=>[...html.matchAll(/<([a-z]+)((?:\s+[a-zA-Z0-9:-]+="[^"]*")*)\s*(\/?)>/g)];

describe('dishIllustration',()=>{
  test('exports exactly the supported kinds',()=>{
    expect([...DISH_KINDS].sort()).toEqual([...KINDS].sort());
  });

  test.each(KINDS)('%s renders a self-contained accessible wide svg',kind=>{
    const html=dishIllustration(kind,'',()=>0);
    expect(html.startsWith('<span ')).toBe(true);
    expect(html.endsWith('</svg></span>')).toBe(true);
    expect(wrapperAttr(html,'class')).toBe(`dish-illustration dish-illustration--${kind}`);
    expect(wrapperAttr(html,'data-dish-kind')).toBe(kind);
    const svg=svgOf(html);
    expect(svg).toContain('viewBox="0 0 480 260"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('#3e3a39');
    expect(svg).toContain('#fffcf6');
    expect(svg.match(/<svg/g)).toHaveLength(1);
    expect(svg).not.toMatch(/<(script|defs|text|image|use|style|foreignObject)\b/i);
    expect(svg).not.toMatch(/\s(id|href|xlink:href|on[a-z]+)=/i);
    expect(svg).not.toMatch(/url\(|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(svg).not.toMatch(/undefined|NaN|\$\{/);
  });

  test.each(KINDS)('%s markup is balanced with no duplicate attributes',kind=>{
    const html=dishIllustration(kind,'',()=>0);
    for(const name of ['span','svg','g']){
      const open=(html.match(new RegExp(`<${name}[\\s>]`,'g'))||[]).length;
      const close=(html.match(new RegExp(`</${name}>`,'g'))||[]).length;
      expect(open).toBe(close);
    }
    for(const [,tag,attrs] of tags(html)){
      const names=[...attrs.matchAll(/([a-zA-Z0-9:-]+)="/g)].map(m=>m[1]);
      expect({tag,dupes:names.filter((n,i)=>names.indexOf(n)!==i)}).toEqual({tag,dupes:[]});
    }
    const stripped=html.replace(/<\/?[a-zA-Z]+(?:\s+[a-zA-Z0-9:-]+="[^"]*")*\s*\/?>/g,'');
    expect(stripped.trim()).toBe('');
  });

  test('each named dish kind draws distinct artwork',()=>{
    const kinds=KINDS.filter(kind=>kind!=='custom');
    const bodies=kinds.map(k=>svgOf(dishIllustration(k,'',()=>0.999)));
    expect(new Set(bodies).size).toBe(kinds.length);
  });

  test.each([undefined,'unknown','',null,42,'constructor','__proto__','toString','HOTPOT','hotpot"><script>'])('falls back to custom for %p',kind=>{
    const html=dishIllustration(kind,'',()=>0);
    expect(wrapperAttr(html,'data-dish-kind')).toBe('custom');
    expect(wrapperAttr(html,'class')).toBe('dish-illustration dish-illustration--custom');
    expect(svgOf(html)).toBe(svgOf(dishIllustration('custom','',()=>0)));
  });

  test('defaults to custom',()=>{
    expect(wrapperAttr(dishIllustration(),'data-dish-kind')).toBe('custom');
  });

  test('randomizes generic food art while keeping specific art stable',()=>{
    const first=dishIllustration('custom','',()=>0);
    const second=dishIllustration('custom','',()=>0.999);
    expect(wrapperAttr(first,'data-dish-kind')).toBe('custom');
    expect(wrapperAttr(second,'data-dish-kind')).toBe('custom');
    expect(wrapperAttr(first,'data-dish-variation')).not.toBe(wrapperAttr(second,'data-dish-variation'));
    expect(svgOf(first)).not.toBe(svgOf(second));
    expect(svgOf(dishIllustration('pasta','',()=>0))).toBe(svgOf(dishIllustration('pasta','',()=>0.999)));
  });

  test('appends and escapes className on the wrapper only',()=>{
    const html=dishIllustration('pasta',`hero "x" <b>&'\``,()=>0);
    expect(wrapperAttr(html,'class')).toBe('dish-illustration dish-illustration--pasta hero &quot;x&quot; &lt;b&gt;&amp;&#39;&#96;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('"x"');
    expect(svgOf(html)).toBe(svgOf(dishIllustration('pasta','',()=>0)));
    expect(dishIllustration('salad',null,()=>0)).toBe(dishIllustration('salad','',()=>0));
  });
});
