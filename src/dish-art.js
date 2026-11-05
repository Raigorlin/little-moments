const C = {
  paper: '#fffcf6',
  ink: '#3e3a39',
  coral: '#efa28f',
  yellow: '#f6d27a',
  sky: '#b7dbe5',
  green: '#b9cda5',
};

const F = {
  rice: '#ffffff',
  bread: '#f8e2b0',
  crust: '#dca46a',
  wood: '#e7c193',
  bagel: '#d9a062',
  curry: '#e2a24f',
  carrot: '#f08c5a',
  meat: '#c97a62',
  broth: '#f3c27f',
  spicy: '#e9806a',
  tomato: '#e8705f',
  leaf: '#8fb07a',
  coffee: '#a8714f',
  grape: '#b7a4d6',
};

const STROKE = `stroke="${C.ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;
const THIN = `stroke="${C.ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
  })[ch]);
}

const steam = (xs, y) => `
  <g stroke="${C.ink}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.55">
    ${xs.map((x) => `<path d="M${x} ${y} q-9 -10 0 -20 t0 -20"/>`).join('')}
  </g>`;

const sparkle = (x, y, s = 1) => `
  <path transform="translate(${x} ${y}) scale(${s})" d="M0 -12 Q2 -2 12 0 Q2 2 0 12 Q-2 2 -12 0 Q-2 -2 0 -12 Z" fill="${C.yellow}" ${STROKE}/>`;

const leaf = (x, y, rot, fill = F.leaf, s = 1) => `
  <path transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" d="M0 0 Q10 -12 24 0 Q10 12 0 0 Z M2 0 H18" fill="${fill}" ${THIN}/>`;

function backdrop(accent, blob) {
  return `
  <rect x="0" y="0" width="480" height="260" rx="28" fill="${C.paper}"/>
  <path d="${blob}" fill="${accent}" opacity="0.45"/>
  <g fill="${C.ink}" opacity="0.18">
    <circle cx="44" cy="40" r="3"/><circle cx="440" cy="52" r="3"/><circle cx="420" cy="228" r="3"/><circle cx="56" cy="214" r="3"/>
  </g>`;
}

const shadow = (cx, cy, rx, ry = 10) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${C.ink}" opacity="0.08"/>`;

function hotpot() {
  return `
  ${backdrop(C.sky, 'M70 120 Q60 40 170 36 Q260 20 330 44 Q430 60 418 140 Q410 220 300 226 Q160 236 96 206 Q66 180 70 120 Z')}
  ${steam([196, 240, 284], 78)}
  ${shadow(240, 232, 130)}
  <g ${STROKE}>
    <rect x="176" y="198" width="128" height="30" rx="10" fill="${C.ink}"/>
    <path d="M214 198 q6 -10 0 -18 q14 6 10 18 M260 198 q6 -10 0 -18 q14 6 10 18" fill="${C.yellow}"/>
    <path d="M96 120 H78 Q68 120 68 130 V134 Q68 142 78 142 H98" fill="${C.coral}"/>
    <path d="M384 120 H402 Q412 120 412 130 V134 Q412 142 402 142 H382" fill="${C.coral}"/>
    <path d="M96 128 Q100 210 240 210 Q380 210 384 128 Z" fill="${C.coral}"/>
    <path d="M128 168 Q240 196 352 168" stroke="${C.paper}" opacity="0.8"/>
    <ellipse cx="240" cy="128" rx="144" ry="44" fill="${C.coral}"/>
    <ellipse cx="240" cy="128" rx="128" ry="36" fill="${F.broth}"/>
    <path d="M240 92 A128 36 0 0 0 240 164 Z" fill="${F.spicy}"/>
    <line x1="240" y1="92" x2="240" y2="164"/>
    <line x1="112" y1="128" x2="368" y2="128"/>
  </g>
  <g ${THIN}>
    <rect x="150" y="104" width="18" height="16" rx="3" fill="${C.paper}"/>
    <rect x="174" y="100" width="18" height="16" rx="3" fill="${C.paper}"/>
    <path d="M204 118 Q206 104 220 104 Q232 104 232 118 Z" fill="${F.coffee}"/>
    <path d="M216 118 V124"/>
    <path d="M140 140 Q156 134 170 142 T200 142 Q190 154 170 152 T140 140 Z" fill="${F.meat}"/>
    <path d="M176 152 Q190 146 206 150 T232 148 Q226 160 206 160 T176 152 Z" fill="${F.meat}"/>
    <path d="M262 112 A12 12 0 1 1 280 120 L274 116 A6 6 0 1 0 266 110 Z" fill="${C.coral}"/>
    <path d="M296 106 A12 12 0 1 1 314 114 L308 110 A6 6 0 1 0 300 104 Z" fill="${C.coral}"/>
    <circle cx="340" cy="114" r="9" fill="${C.yellow}"/>
    <circle cx="340" cy="114" r="3" fill="${C.paper}"/>
    <path d="M300 136 V158 M306 136 V160 M312 136 V158 M318 138 V156" />
    <path d="M296 136 Q308 130 322 136" fill="${C.paper}"/>
  </g>
  ${leaf(252, 146, -10, C.green)}
  ${leaf(328, 144, 20, F.leaf)}
  ${leaf(340, 150, -30, C.green, 0.8)}`;
}

function kebab(x, y, pieces) {
  const fills = { meat: F.meat, pepper: F.leaf, onion: C.paper, tomato: F.tomato };
  return `
  <g ${STROKE}>
    <line x1="${x - 18}" y1="${y}" x2="${x + pieces.length * 30 + 22}" y2="${y}" stroke="${F.crust}" stroke-width="5"/>
    <line x1="${x - 18}" y1="${y}" x2="${x + pieces.length * 30 + 22}" y2="${y}"/>
    ${pieces.map((p, i) => {
      const px = x + i * 30;
      const marks = p === 'meat' ? `<path d="M${px + 6} ${y - 6} l6 -6 M${px + 6} ${y + 8} l10 -10" ${THIN}/>` : '';
      return `<rect x="${px}" y="${y - 14}" width="24" height="28" rx="8" fill="${fills[p]}"/>${marks}`;
    }).join('')}
  </g>`;
}

function bbq() {
  const bars = [128, 160, 192, 224, 256, 288, 320, 352].map((x) => `<line x1="${x}" y1="140" x2="${x}" y2="152"/>`).join('');
  const kernels = [0, 1, 2, 3, 4].map((i) => `<line x1="${322 + i * 12}" y1="97" x2="${322 + i * 12}" y2="125"/>`).join('');
  return `
  ${backdrop(C.yellow, 'M60 140 Q50 60 150 44 Q250 26 350 46 Q440 70 426 150 Q412 224 300 228 Q150 236 88 206 Q62 186 60 140 Z')}
  <g stroke="${C.ink}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.4">
    <path d="M160 70 q-10 -12 0 -24 t0 -22"/>
    <path d="M260 62 q-10 -12 0 -24 t0 -18"/>
  </g>
  ${shadow(240, 240, 120)}
  <g ${STROKE}>
    <line x1="170" y1="196" x2="146" y2="240"/>
    <line x1="310" y1="196" x2="334" y2="240"/>
    <line x1="240" y1="206" x2="240" y2="240"/>
    <path d="M108 150 Q118 210 240 210 Q362 210 372 150 Z" fill="${C.coral}"/>
    <path d="M132 166 Q240 190 348 166" stroke="${C.paper}" opacity="0.8"/>
    <circle cx="240" cy="186" r="6" fill="${C.paper}"/>
    <rect x="100" y="138" width="280" height="16" rx="8" fill="${C.ink}"/>
    <path d="M170 140 q4 -10 0 -16 q12 6 8 16 M254 140 q4 -10 0 -16 q12 6 8 16" fill="${C.yellow}"/>
  </g>
  <g stroke="${C.paper}" stroke-width="2" stroke-linecap="round" opacity="0.7">${bars}</g>
  ${kebab(132, 124, ['meat', 'pepper', 'onion', 'meat', 'tomato'])}
  ${kebab(118, 96, ['meat', 'onion', 'pepper', 'meat'])}
  <g ${STROKE}>
    <path d="M300 96 Q300 90 306 90 H372 Q386 90 386 111 Q386 132 372 132 H306 Q300 132 300 126 Z" fill="${C.yellow}"/>
    <path d="M300 92 Q280 96 268 116 Q286 120 300 130 Z" fill="${C.green}"/>
    <path d="M300 104 Q284 110 276 128 Q292 128 300 124" fill="${F.leaf}"/>
  </g>
  <g ${THIN} opacity="0.7">
    ${kernels}
    <path d="M312 104 H380 M312 118 H380"/>
  </g>
  <g ${THIN}>
    <path d="M336 104 l8 6 M356 116 l8 6" stroke="${C.ink}"/>
  </g>`;
}

function toast() {
  return `
  ${backdrop(C.coral, 'M54 130 Q52 54 150 44 Q240 34 320 50 Q430 66 428 140 Q426 214 320 226 Q170 238 98 210 Q56 190 54 130 Z')}
  ${steam([372, 396], 92)}
  ${shadow(210, 222, 150, 12)}
  <g ${STROKE}>
    <ellipse cx="210" cy="176" rx="160" ry="50" fill="${C.paper}"/>
    <ellipse cx="210" cy="176" rx="128" ry="36"/>
    <path d="M96 176 Q92 168 98 160 L148 96 Q156 88 164 96 L212 162 Q218 172 208 176 Z" fill="${F.crust}"/>
    <path d="M110 168 L154 108 L198 168 Z" fill="${F.bread}" stroke="none"/>
    <path d="M152 186 Q148 178 154 170 L210 112 Q218 104 226 112 L270 176 Q276 186 266 188 Z" fill="${F.crust}"/>
    <path d="M168 180 L218 124 L258 180 Z" fill="${F.bread}" stroke="none"/>
    <rect x="204" y="150" width="22" height="16" rx="4" fill="${C.yellow}" transform="rotate(-12 215 158)"/>
    <path d="M276 160 Q272 140 292 138 Q308 126 324 140 Q346 142 340 162 Q344 182 318 184 Q298 192 284 180 Q266 176 276 160 Z" fill="${F.rice}"/>
    <circle cx="308" cy="160" r="14" fill="${C.yellow}"/>
  </g>
  <path d="M302 154 q4 -4 10 -2" stroke="${C.paper}" stroke-width="3" stroke-linecap="round" fill="none"/>
  <g ${STROKE}>
    <ellipse cx="392" cy="186" rx="50" ry="12" fill="${C.paper}"/>
    <path d="M422 128 Q446 128 446 148 Q446 168 420 168" fill="none"/>
    <path d="M354 112 H426 V164 Q426 182 404 182 H376 Q354 182 354 164 Z" fill="${C.sky}"/>
    <ellipse cx="390" cy="112" rx="36" ry="8" fill="${F.coffee}"/>
    <path d="M364 138 Q390 146 416 138" stroke="${C.paper}"/>
  </g>`;
}

function curry() {
  const grains = [[150, 132, 20], [172, 124, -20], [194, 130, 30], [140, 152, -10], [166, 148, 15], [196, 150, -30], [218, 144, 10], [158, 170, 25], [188, 172, -15], [214, 166, 20]]
    .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="5" ry="2.5" transform="rotate(${r} ${x} ${y})"/>`).join('');
  return `
  ${backdrop(C.green, 'M50 140 Q44 60 140 46 Q240 30 340 46 Q440 62 430 146 Q424 218 316 228 Q166 240 92 210 Q54 190 50 140 Z')}
  ${steam([200, 290], 92)}
  ${shadow(240, 226, 160, 12)}
  <g ${STROKE}>
    <ellipse cx="240" cy="166" rx="176" ry="56" fill="${C.paper}"/>
    <ellipse cx="240" cy="166" rx="148" ry="44" fill="${C.sky}" opacity="0.5"/>
    <path d="M118 166 Q106 124 160 114 Q222 100 246 136 Q262 170 232 190 Q166 204 118 166 Z" fill="${F.rice}"/>
    <path d="M238 132 Q290 112 350 128 Q384 146 364 178 Q326 202 236 192 Q254 162 238 132 Z" fill="${F.curry}"/>
    <path d="M262 150 l14 -12 l8 16 Z" fill="${F.carrot}"/>
    <path d="M318 168 l16 -10 l6 16 Z" fill="${F.carrot}"/>
    <rect x="290" y="138" width="20" height="18" rx="5" fill="${C.yellow}"/>
    <rect x="270" y="166" width="20" height="16" rx="5" fill="${C.yellow}" transform="rotate(10 280 174)"/>
    <path d="M326 140 Q336 130 348 140 Q344 154 330 152 Z" fill="${F.meat}"/>
  </g>
  <g ${THIN} fill="${C.paper}" opacity="0.8">${grains}</g>
  <g fill="${F.leaf}" ${THIN}>
    <circle cx="180" cy="114" r="4"/><circle cx="190" cy="110" r="3"/>
  </g>
  <g ${STROKE}>
    <line x1="446" y1="84" x2="446" y2="170"/>
    <ellipse cx="446" cy="190" rx="13" ry="20" fill="${C.paper}"/>
  </g>`;
}

function pasta() {
  return `
  ${backdrop(C.yellow, 'M56 136 Q52 56 152 42 Q250 30 336 48 Q432 66 426 146 Q420 218 316 226 Q166 238 96 210 Q58 190 56 136 Z')}
  ${steam([200, 244, 288], 70)}
  ${shadow(232, 228, 160, 12)}
  <g ${STROKE}>
    <ellipse cx="232" cy="166" rx="172" ry="56" fill="${C.paper}"/>
    <ellipse cx="232" cy="166" rx="140" ry="42" stroke="${C.sky}"/>
    <path d="M132 160 Q128 112 232 110 Q336 112 332 160 Q330 196 232 198 Q134 196 132 160 Z" fill="${C.yellow}"/>
  </g>
  <g stroke="#d9a84f" stroke-width="3" stroke-linecap="round" fill="none">
    <path d="M150 162 A84 30 0 0 1 316 158"/>
    <path d="M160 176 A74 22 0 0 0 306 172"/>
    <path d="M170 150 A64 22 0 0 1 296 150"/>
    <path d="M180 168 A54 16 0 0 0 286 166"/>
    <path d="M196 156 A38 12 0 0 1 270 156"/>
  </g>
  <g ${STROKE}>
    <path d="M196 140 Q200 120 232 122 Q266 120 270 140 Q262 158 232 156 Q202 158 196 140 Z" fill="${F.tomato}"/>
    <circle cx="164" cy="138" r="13" fill="${F.tomato}"/>
    <circle cx="306" cy="148" r="13" fill="${F.tomato}"/>
  </g>
  <path d="M160 134 q4 -4 9 -2 M302 144 q4 -4 9 -2" stroke="${C.paper}" stroke-width="3" stroke-linecap="round" fill="none"/>
  <g fill="${C.paper}" ${THIN}>
    <rect x="214" y="132" width="6" height="5" rx="1"/><rect x="246" y="138" width="6" height="5" rx="1"/><rect x="232" y="146" width="5" height="5" rx="1"/>
  </g>
  ${leaf(224, 126, -40, F.leaf)}
  ${leaf(238, 128, -140, C.green)}
  <g ${STROKE}>
    <line x1="440" y1="104" x2="440" y2="210"/>
    <path d="M428 74 V96 Q428 108 440 108 Q452 108 452 96 V74 M440 74 V100" fill="none"/>
  </g>`;
}

function breakfast() {
  const seeds = [[140, 118, 30], [162, 108, -10], [188, 110, 20], [208, 124, -30], [214, 150, 10], [130, 146, -20], [140, 174, 40], [200, 176, -40], [170, 190, 0]]
    .map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="4" ry="2" transform="rotate(${r} ${x} ${y})"/>`).join('');
  return `
  ${backdrop(C.sky, 'M54 132 Q50 56 150 44 Q246 32 334 48 Q432 64 428 144 Q424 216 318 226 Q168 238 96 210 Q58 190 54 132 Z')}
  ${shadow(220, 232, 170, 10)}
  <g ${STROKE}>
    <rect x="62" y="168" width="300" height="56" rx="24" fill="${F.wood}"/>
    <path d="M92 196 H180 M210 210 H330 M250 186 H320" opacity="0.5"/>
    <circle cx="174" cy="148" r="58" fill="${F.bagel}"/>
    <path d="M134 120 Q174 92 214 120" stroke="${C.paper}" opacity="0.7"/>
    <ellipse cx="174" cy="150" rx="18" ry="14" fill="${F.wood}"/>
  </g>
  <g fill="${C.paper}" ${THIN}>${seeds}</g>
  <g ${STROKE}>
    <path d="M262 162 Q256 136 282 134 Q306 136 300 162 Q292 186 281 192 Q270 186 262 162 Z" fill="${F.tomato}"/>
    <path d="M268 136 l6 -10 l7 8 l7 -8 l6 10" fill="${F.leaf}"/>
    <circle cx="330" cy="190" r="22" fill="${C.yellow}"/>
    <circle cx="330" cy="190" r="15" fill="${F.broth}"/>
    <path d="M330 175 V205 M315 190 H345 M319 179 L341 201 M341 179 L319 201" ${THIN}/>
  </g>
  <g fill="${C.yellow}" ${THIN}>
    <circle cx="276" cy="154" r="1.5"/><circle cx="288" cy="160" r="1.5"/><circle cx="280" cy="172" r="1.5"/>
  </g>
  <g ${STROKE} fill="${F.grape}">
    <circle cx="232" cy="198" r="9"/><circle cx="248" cy="204" r="9"/><circle cx="240" cy="188" r="9"/><circle cx="256" cy="192" r="9"/>
  </g>
  <g ${STROKE}>
    <path d="M396 70 H428 V84 Q444 98 444 118 V210 Q444 222 432 222 H392 Q380 222 380 210 V118 Q380 98 396 84 Z" fill="${C.paper}"/>
    <rect x="392" y="56" width="40" height="16" rx="5" fill="${C.coral}"/>
    <path d="M380 140 H444 V184 H380" fill="${C.sky}"/>
    <path d="M412 152 q-10 8 0 20 q10 -12 0 -20 Z" fill="${C.paper}" ${THIN}/>
  </g>`;
}

function salad() {
  const leaves = [
    [120, 132, -30, C.green, 2.4], [150, 112, -50, F.leaf, 2.6], [196, 98, -70, C.green, 2.6],
    [246, 94, -100, F.leaf, 2.6], [292, 100, -120, C.green, 2.6], [330, 118, -140, F.leaf, 2.4], [358, 136, -160, C.green, 2],
  ].map(([x, y, r, f, s]) => `
  <path transform="translate(${x} ${y}) rotate(${r}) scale(${s})" d="M0 0 Q4 -10 12 -8 Q16 -14 22 -8 Q30 -6 28 0 Q30 6 22 8 Q16 14 12 8 Q4 10 0 0 Z" fill="${f}" stroke="${C.ink}" stroke-width="1.2" stroke-linejoin="round"/>`).join('');
  return `
  ${backdrop(C.coral, 'M56 134 Q52 58 150 44 Q244 30 332 46 Q430 62 426 142 Q422 216 316 226 Q166 238 96 210 Q58 190 56 134 Z')}
  ${shadow(240, 234, 120, 10)}
  <g ${STROKE}>
    <line x1="352" y1="40" x2="306" y2="128" stroke="${F.crust}" stroke-width="8"/>
    <ellipse cx="240" cy="142" rx="146" ry="24" fill="${F.leaf}"/>
  </g>
  ${leaves}
  <g ${STROKE}>
    <circle cx="186" cy="120" r="18" fill="${F.tomato}"/>
    <circle cx="300" cy="126" r="16" fill="${F.tomato}"/>
    <circle cx="246" cy="114" r="16" fill="${C.paper}"/>
    <circle cx="246" cy="114" r="10" fill="${C.green}" ${THIN}/>
    <circle cx="146" cy="136" r="13" fill="${C.paper}"/>
    <circle cx="146" cy="136" r="8" fill="${C.green}" ${THIN}/>
    <rect x="212" y="128" width="40" height="10" rx="5" fill="${F.carrot}" transform="rotate(-20 232 133)"/>
    <rect x="320" y="132" width="34" height="9" rx="4.5" fill="${F.carrot}" transform="rotate(16 337 136)"/>
    <path d="M262 136 A16 10 0 0 1 292 136" stroke="${F.grape}" stroke-width="5"/>
  </g>
  <g fill="${C.yellow}" ${THIN}>
    <circle cx="180" cy="116" r="2"/><circle cx="192" cy="124" r="2"/><circle cx="296" cy="122" r="2"/><circle cx="304" cy="130" r="2"/>
  </g>
  <g ${STROKE}>
    <path d="M94 142 Q102 228 240 228 Q378 228 386 142 Q380 166 240 166 Q100 166 94 142 Z" fill="${C.sky}"/>
    <path d="M136 194 Q240 214 344 194" stroke="${C.paper}"/>
    <path d="M168 176 l6 6 M208 182 l6 6 M248 184 l6 6 M288 182 l6 6 M326 176 l6 6" ${THIN}/>
  </g>`;
}

function custom() {
  return `
  ${backdrop(C.green, 'M58 136 Q54 58 152 44 Q248 30 334 46 Q430 62 424 142 Q420 214 316 224 Q168 236 98 208 Q60 188 58 136 Z')}
  ${sparkle(110, 72, 1.1)}
  ${sparkle(380, 64, 0.8)}
  ${sparkle(400, 130, 0.6)}
  ${shadow(240, 226, 170, 10)}
  <g ${STROKE}>
    <ellipse cx="240" cy="200" rx="164" ry="26" fill="${C.paper}"/>
    <path d="M118 196 Q118 84 240 84 Q362 84 362 196 Z" fill="${C.yellow}"/>
    <path d="M146 166 Q150 112 206 102" stroke="${C.paper}"/>
    <line x1="108" y1="196" x2="372" y2="196"/>
    <circle cx="240" cy="74" r="11" fill="${C.coral}"/>
    <path d="M172 180 H308" stroke="${C.coral}" stroke-width="6"/>
  </g>
  <g ${STROKE}>
    <line x1="52" y1="120" x2="52" y2="222"/>
    <path d="M40 92 V112 Q40 124 52 124 Q64 124 64 112 V92 M52 92 V116" fill="none"/>
    <line x1="430" y1="150" x2="430" y2="222"/>
    <ellipse cx="430" cy="128" rx="12" ry="20" fill="${C.sky}"/>
  </g>`;
}

const DISHES = { hotpot, bbq, toast, curry, pasta, breakfast, salad, custom };

export const DISH_KINDS = Object.freeze(Object.keys(DISHES));

export function dishIllustration(kind = 'custom', className = '') {
  const key = Object.prototype.hasOwnProperty.call(DISHES, kind) ? kind : 'custom';
  const cls = escapeAttr(['dish-illustration', `dish-illustration--${key}`, className].filter(Boolean).join(' '));
  return `<span class="${cls}" data-dish-kind="${key}" style="display:block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 260" preserveAspectRatio="xMidYMid meet" class="dish-illustration__svg" aria-hidden="true" focusable="false" fill="none" style="display:block;width:100%;height:auto">${DISHES[key]()}</svg></span>`;
}
