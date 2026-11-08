const C = {
  paper: '#fffcf6',
  ink: '#3e3a39',
  coral: '#efa28f',
  yellow: '#f6d27a',
  sky: '#b7dbe5',
  green: '#b9cda5',
};

const STROKE = `stroke="${C.ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;

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

function svg(width, height, className, body, extraClass = '', options = {}) {
  const cls = escapeAttr([extraClass, className].filter(Boolean).join(' '));
  const preserveAspectRatio = ['xMidYMid meet', 'xMidYMid slice', 'xMidYMax meet'].includes(options.preserveAspectRatio) ? options.preserveAspectRatio : 'xMidYMid meet';
  const content = options.transparentBackground ? body.replace(/^\s*<rect\b[^>]*\/>/, '') : body;
  const sizing = options.fullFrame ? 'width:100%;height:100%;max-width:none' : 'max-width:100%;height:auto';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="${preserveAspectRatio}" class="${cls}" aria-hidden="true" focusable="false" fill="none" style="display:block;${sizing}">${content}</svg>`;
}

const sun = (cx, cy, r) => `
  <g class="scene-layer scene-sun"><g ${STROKE}>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.yellow}"/>
    ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const rad = (a * Math.PI) / 180;
      const x1 = cx + Math.cos(rad) * (r + 8);
      const y1 = cy + Math.sin(rad) * (r + 8);
      const x2 = cx + Math.cos(rad) * (r + 18);
      const y2 = cy + Math.sin(rad) * (r + 18);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join('')}
  </g></g>`;

const cloud = (x, y, s = 1) => `
  <g class="scene-layer scene-cloud"><path transform="translate(${x} ${y}) scale(${s})" d="M0 20 Q0 6 14 8 Q20 -4 34 2 Q48 -2 50 12 Q62 12 62 22 Q62 30 52 30 H8 Q0 30 0 20 Z" fill="${C.paper}" ${STROKE}/></g>`;

const pine = (x, base, h, fill = C.green) => {
  const w = h * 0.42;
  return `
  <g class="scene-layer scene-tree"><g ${STROKE}>
    <line x1="${x}" y1="${base}" x2="${x}" y2="${base - h * 0.18}"/>
    <path d="M${x} ${base - h} L${x + w * 0.62} ${base - h * 0.58} H${x + w * 0.32} L${x + w} ${base - h * 0.18} H${x - w} L${x - w * 0.32} ${base - h * 0.58} H${x - w * 0.62} Z" fill="${fill}"/>
  </g></g>`;
};

const van = (x, y, s = 1) => `
  <g class="scene-layer scene-van"><g class="scene-layer scene-van-bounce"><g transform="translate(${x} ${y}) scale(${s})" ${STROKE}>
    <path d="M10 70 V28 Q10 8 32 8 H150 Q170 8 178 28 L192 54 Q196 60 196 70 V84 Q196 90 190 90 H16 Q10 90 10 84 Z" fill="${C.yellow}"/>
    <path d="M10 56 H196" />
    <rect x="28" y="22" width="40" height="26" rx="6" fill="${C.sky}"/>
    <rect x="80" y="22" width="40" height="26" rx="6" fill="${C.sky}"/>
    <path d="M134 22 H160 Q166 22 170 30 L180 48 H134 Z" fill="${C.sky}"/>
    <line x1="126" y1="56" x2="126" y2="84"/>
    <line x1="114" y1="66" x2="120" y2="66"/>
    <path d="M24 60 H112" stroke="${C.coral}" stroke-width="6"/>
    <path d="M40 8 V0 H120 V8"/>
    <circle cx="190" cy="66" r="3" fill="${C.paper}"/>
    <circle cx="50" cy="90" r="16" fill="${C.ink}"/>
    <circle cx="50" cy="90" r="6" fill="${C.paper}"/>
    <circle cx="158" cy="90" r="16" fill="${C.ink}"/>
    <circle cx="158" cy="90" r="6" fill="${C.paper}"/>
  </g></g></g>`;

const tent = (x, y, s = 1) => `
  <g transform="translate(${x} ${y}) scale(${s})" ${STROKE}>
    <path d="M0 100 L70 0 L140 100 Z" fill="${C.coral}"/>
    <path d="M70 0 L48 100 H92 Z" fill="${C.paper}"/>
    <line x1="70" y1="0" x2="70" y2="100"/>
    <line x1="70" y1="0" x2="62" y2="-12"/>
    <line x1="70" y1="0" x2="78" y2="-12"/>
    <line x1="-14" y1="100" x2="154" y2="100"/>
  </g>`;

function camp(className, options) {
  return svg(680, 340, className, `
  <rect x="0" y="0" width="680" height="340" fill="var(--soft, ${C.paper})"/>
  ${sun(560, 72, 28)}
  ${cloud(80, 50, 1)}
  ${cloud(330, 34, 0.8)}
  <g ${STROKE}>
    <path d="M-10 250 L130 96 L210 170 L320 60 L440 190 L520 120 L690 260 Z" fill="${C.sky}"/>
    <path d="M320 60 L292 92 L310 88 L322 104 L338 86 L352 96 Z" fill="${C.paper}"/>
    <path d="M130 96 L110 118 L126 114 L136 126 L150 114 Z" fill="${C.paper}"/>
    <path d="M-10 262 Q90 222 200 246 T420 238 T690 244 V350 H-10 Z" fill="${C.green}"/>
    <path d="M-10 300 Q140 272 300 292 T690 286 V350 H-10 Z" fill="${C.paper}"/>
  </g>
  ${pine(250, 258, 92)}
  ${pine(286, 252, 70)}
  ${pine(430, 250, 84)}
  ${pine(640, 262, 100)}
  ${van(40, 184, 0.98)}
  ${tent(468, 196, 1)}
  <g ${STROKE}>
    <g class="scene-layer scene-flame"><path d="M370 300 Q376 286 384 300" fill="${C.coral}"/></g>
    <line x1="362" y1="304" x2="392" y2="304"/>
  </g>`, 'illustration illustration--camp', options);
}

function travel(className, options) {
  return svg(680, 250, className, `
  <rect x="0" y="0" width="680" height="250" fill="${C.paper}"/>
  ${options.hideSun ? '' : sun(110, 64, 24)}
  ${cloud(470, 36, 0.9)}
  <g ${STROKE}>
    <path d="M-10 170 L120 92 L200 140 L300 70 L420 150 L520 96 L690 176 Z" fill="${C.sky}"/>
    <path d="M-10 178 Q160 150 340 172 T690 168 V260 H-10 Z" fill="${C.green}"/>
    <path d="M-10 214 H690" />
    <path d="M40 230 H110 M180 230 H250 M320 230 H390 M460 230 H530 M600 230 H660"/>
  </g>
  ${pine(70, 182, 70)}
  ${pine(600, 180, 80)}
  ${pine(636, 184, 58)}
  ${van(240, 108, 1)}
  <g ${STROKE}>
    <line x1="200" y1="150" x2="224" y2="150"/>
    <line x1="190" y1="170" x2="222" y2="170"/>
    <line x1="206" y1="190" x2="226" y2="190"/>
  </g>`, 'illustration illustration--travel', options);
}

function lake(className, options) {
  return svg(680, 250, className, `
  <rect x="0" y="0" width="680" height="250" fill="${C.paper}"/>
  ${sun(548, 58, 25)}
  ${cloud(92, 40, 0.8)}
  <g ${STROKE}>
    <path d="M-10 172 L112 94 L202 154 L318 76 L430 154 L520 104 L690 176 Z" fill="${C.sky}"/>
    <path d="M-10 176 Q150 154 330 174 T690 168 V260 H-10 Z" fill="${C.sky}"/>
    <path d="M250 178 Q340 170 430 178 M205 193 Q330 184 470 194 M270 211 Q340 205 410 212 M130 228 Q300 219 520 230" fill="none"/>
    <path d="M-10 170 Q90 150 178 172 L210 250 H-10 Z" fill="${C.green}"/>
    <path d="M690 174 Q588 150 504 172 L470 250 H690 Z" fill="${C.green}"/>
  </g>
  ${pine(82, 174, 76)}
  ${pine(122, 168, 56)}
  ${pine(596, 174, 68)}
  <g ${STROKE}><path d="M302 188 Q340 174 378 188 L368 212 H312 Z" fill="${C.coral}"/><path d="M302 188 L340 156 L378 188 Z" fill="${C.yellow}"/><line x1="340" y1="156" x2="340" y2="212"/></g>`, 'illustration illustration--lake', options);
}

function forest(className, options) {
  return svg(680, 250, className, `
  <rect x="0" y="0" width="680" height="250" fill="${C.paper}"/>
  ${sun(552, 52, 23)}
  <g ${STROKE}>
    <path d="M-10 150 Q140 112 300 152 T690 140 V260 H-10 Z" fill="${C.green}"/>
    <path d="M0 250 Q198 196 350 214 Q500 188 680 250 Z" fill="${C.yellow}"/>
    <path d="M272 250 Q320 211 350 214 Q383 222 408 250" fill="none"/>
  </g>
  ${pine(52, 188, 140)}
  ${pine(110, 178, 108)}
  ${pine(174, 190, 145)}
  ${pine(508, 182, 128)}
  ${pine(574, 192, 154)}
  ${pine(638, 180, 112)}
  <g ${STROKE}>
    <path d="M278 196 L340 140 L402 196 Z" fill="${C.coral}"/>
    <path d="M340 140 L320 196 H360 Z" fill="${C.paper}"/>
    <line x1="264" y1="196" x2="416" y2="196"/>
    <path d="M438 226 Q444 210 450 226 M432 230 H456" fill="${C.coral}"/>
  </g>`, 'illustration illustration--forest', options);
}

function beach(className, options) {
  return svg(680, 250, className, `
  <rect x="0" y="0" width="680" height="250" fill="${C.paper}"/>
  ${sun(540, 56, 27)}
  <g ${STROKE}>
    <path d="M-10 140 Q140 120 270 142 T690 136 V210 H-10 Z" fill="${C.sky}"/>
    <path d="M-10 154 Q120 140 250 158 T690 150 M-10 178 Q130 164 280 181 T690 174" fill="none"/>
    <path d="M-10 188 Q180 166 330 190 T690 178 V260 H-10 Z" fill="${C.yellow}"/>
    <path d="M510 250 Q532 202 568 180 Q607 202 628 250 Z" fill="${C.coral}"/>
    <path d="M568 180 V250" fill="none"/>
    <path d="M62 192 Q68 172 74 192 M56 196 H80" fill="${C.green}"/>
    <path d="M600 100 Q586 145 604 178 M600 126 Q574 116 568 103 M600 139 Q626 122 639 112 M596 124 Q590 105 596 91" fill="none"/>
  </g>
  <path d="M600 101 Q578 93 568 103 Q582 118 599 118 M600 126 Q622 110 639 112 Q633 130 600 141 M598 124 Q582 103 596 91 Q608 105 602 126" fill="${C.green}" stroke="${C.ink}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="142" cy="210" r="13" fill="${C.paper}" ${STROKE}/><path d="M130 210 H154 M142 197 V223" ${STROKE}/>
  <path d="M264 215 Q280 197 296 215 M280 201 V229" ${STROKE}/><path d="M260 230 H300" ${STROKE}/>`, 'illustration illustration--beach', options);
}

function sunrise(className, options) {
  return svg(680, 250, className, `
  <rect x="0" y="0" width="680" height="250" fill="${C.paper}"/>
  ${cloud(84, 48, 0.8)}
  <g ${STROKE}>
    <path d="M-10 172 L112 100 L210 160 L330 72 L448 164 L538 106 L690 178 Z" fill="${C.sky}"/>
    <path d="M-10 180 Q160 158 340 178 T690 170 V260 H-10 Z" fill="${C.green}"/>
    <path d="M284 178 A56 56 0 0 1 396 178" fill="${C.yellow}"/>
    <path d="M-10 188 Q160 180 340 190 T690 184 V260 H-10 Z" fill="${C.sky}"/>
    <path d="M270 207 H410 M244 224 H436 M296 240 H384" fill="none"/>
    <path d="M-10 212 Q150 200 300 215 T690 208 V260 H-10 Z" fill="${C.green}"/>
  </g>
  ${pine(74, 190, 80)}
  ${pine(604, 188, 94)}
  <g ${STROKE}><path d="M284 194 Q340 178 396 194 L384 220 H296 Z" fill="${C.coral}"/><path d="M284 194 L340 162 L396 194 Z" fill="${C.yellow}"/><line x1="340" y1="162" x2="340" y2="220"/></g>`, 'illustration illustration--sunrise', options);
}

function meal(className) {
  return svg(240, 200, className, `
  <rect x="0" y="0" width="240" height="200" rx="20" fill="${C.paper}"/>
  <g ${STROKE}>
    <path d="M96 44 Q86 30 96 18 M120 44 Q110 30 120 18 M144 44 Q134 30 144 18"/>
    <line x1="62" y1="62" x2="178" y2="62"/>
    <path d="M70 62 V112 Q70 136 96 136 H144 Q170 136 170 112 V62" fill="${C.coral}"/>
    <path d="M70 76 H52 M170 76 H188"/>
    <path d="M86 92 H154" stroke="${C.paper}"/>
    <path d="M80 182 L120 146 L160 182" />
    <path d="M100 182 L120 160 L140 182" />
    <path d="M108 168 Q120 140 132 168 Q120 180 108 168 Z" fill="${C.yellow}"/>
    <line x1="56" y1="184" x2="184" y2="184"/>
  </g>`, 'illustration illustration--meal');
}

function market(className) {
  return svg(240, 200, className, `
  <rect x="0" y="0" width="240" height="200" rx="20" fill="${C.paper}"/>
  <g ${STROKE}>
    <path d="M104 74 Q100 40 120 40 Q140 40 136 74" />
    <path d="M124 60 Q128 30 150 26 Q146 52 128 62" fill="${C.green}"/>
    <rect x="132" y="44" width="24" height="44" rx="6" fill="${C.sky}"/>
    <circle cx="96" cy="68" r="16" fill="${C.coral}"/>
    <line x1="96" y1="52" x2="100" y2="44"/>
    <path d="M70 74 H170 L160 172 Q159 180 150 180 H90 Q81 180 80 172 Z" fill="${C.yellow}"/>
    <path d="M92 108 H148"/>
    <line x1="48" y1="182" x2="192" y2="182"/>
  </g>`, 'illustration illustration--market');
}

function night(className, options) {
  const stars = [[60, 50], [150, 30], [250, 70], [380, 40], [470, 80], [600, 34], [640, 96], [320, 110]]
    .map(([x, y]) => `<path d="M${x} ${y - 6} V${y + 6} M${x - 6} ${y} H${x + 6}"/>`).join('');
  return svg(680, 300, className, `
  <rect x="0" y="0" width="680" height="300" fill="${C.ink}"/>
  <g class="scene-layer scene-cloud" stroke="${C.paper}" stroke-width="3" stroke-linecap="round">${stars}</g>
  <g class="scene-layer scene-sun"><path d="M560 40 A34 34 0 1 0 596 92 A26 26 0 1 1 560 40 Z" fill="${C.yellow}" stroke="${C.paper}" stroke-width="3" stroke-linejoin="round"/></g>
  <g stroke="${C.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-10 220 L120 110 L210 180 L330 90 L450 190 L540 140 L690 230 Z" fill="${C.sky}" fill-opacity="0.35"/>
    <path d="M-10 236 Q160 206 340 228 T690 224 V310 H-10 Z" fill="${C.green}" fill-opacity="0.55"/>
  </g>
  <g stroke="${C.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M90 236 L130 170 L170 236 Z" fill="${C.ink}"/>
    <path d="M560 240 L600 160 L640 240 Z" fill="${C.ink}"/>
    <path d="M300 266 L370 176 L440 266 Z" fill="${C.coral}"/>
    <path d="M370 176 L352 266 H388 Z" fill="${C.yellow}"/>
    <line x1="284" y1="266" x2="456" y2="266"/>
    <path d="M498 270 L512 254 L526 270" />
    <path d="M504 262 Q512 236 520 262 Q512 272 504 262 Z" fill="${C.coral}"/>
  </g>`, 'illustration illustration--night', options);
}

const KINDS = { camp, travel, lake, forest, beach, sunrise, meal, market, night };

export function illustration(kind = 'camp', className = '', options = {}) {
  const render = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : camp;
  return render(className, options);
}

export function logo() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44" aria-hidden="true" focusable="false" fill="none" class="logo-mark">
  <rect x="2" y="2" width="40" height="40" rx="12" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>
  <circle cx="31" cy="13" r="4.5" fill="${C.yellow}" stroke="${C.ink}" stroke-width="2"/>
  <path d="M9 33 L20 15 L31 33 Z" fill="${C.coral}" stroke="${C.ink}" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M20 15 L17 33 H23 Z" fill="${C.paper}" stroke="${C.ink}" stroke-width="2" stroke-linejoin="round"/>
  <line x1="7" y1="33" x2="37" y2="33" stroke="${C.ink}" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;
}
