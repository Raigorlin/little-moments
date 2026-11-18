// Journal view of the plan (replaces the canvas poster): a hand-drawn "camping journal" built from plain DOM.
// All trip text is written with textContent; the only markup strings are the fixed decorative SVGs below.
const SVG = (body, w = 24, h = 24, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4" fill="#F2C55B"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  cup: '<path d="M5 9h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9Z" fill="#F4E4C8"/><path d="M16 10h1.5a2 2 0 0 1 0 4H16M8 4c0 1 1 1 1 2M11 4c0 1 1 1 1 2"/>',
  bowl: '<path d="M4 11h16a8 8 0 0 1-16 0Z" fill="#F4D7B0"/><path d="M9 7c0 1 1 1 1 2M13 6c0 1 1 1 1 2"/>',
  tent: '<path d="M3 20 12 5l9 15H3Z" fill="#F2C97A"/><path d="m12 5-3 15M12 5l3 15M2 20h20"/>',
  pot: '<path d="M5 10h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6Z" fill="#E98C73"/><path d="M3 10h18M9 6c0 1 1 1 1 2M14 6c0 1 1 1 1 2"/>',
  moon: '<path d="M16 4a7 7 0 1 0 4 12 6 6 0 0 1-4-12Z" fill="#F2C55B"/>',
  camera: '<rect x="3" y="7" width="18" height="12" rx="2.5" fill="#BFD7DE"/><circle cx="12" cy="13" r="3.2"/><path d="M8.5 7 10 4.5h4L15.5 7"/>',
  cards: '<rect x="4" y="6" width="9" height="13" rx="1.5" fill="#F4E4C8" transform="rotate(-8 8 12)"/><rect x="11" y="5" width="9" height="13" rx="1.5" fill="#fff"/><path d="M15.5 9.5v4"/>',
  car: '<path d="M4 15v-4l2-4h10l3 4h1v4H4Z" fill="currentColor" stroke="#3e3a39"/><path d="M6.5 11h11" stroke="#3e3a39"/><circle cx="8" cy="16" r="1.8" fill="#fff" stroke="#3e3a39"/><circle cx="16" cy="16" r="1.8" fill="#fff" stroke="#3e3a39"/>',
  box: '<path d="M4 8 12 4l8 4v9l-8 4-8-4V8Z" fill="#E9C99B"/><path d="m4 8 8 4 8-4M12 12v9"/>',
  broom: '<path d="M15 3 9.5 12" /><path d="M7 11l5 3-2 6-6-3 3-6Z" fill="#F2C97A"/>',
  basket: '<path d="M3 10h18l-2 9H5l-2-9Z" fill="#E9C99B"/><path d="M7 10l3-6M17 10l-3-6M9 13v3M12 13v3M15 13v3"/>',
  people: '<circle cx="9" cy="8" r="3" fill="#F4D7B0"/><circle cx="16" cy="9" r="2.5" fill="#BFD7DE"/><path d="M4 19c.5-3 2.5-5 5-5s4.5 2 5 5M13.5 19c.3-2 1.5-3.5 3-3.5s2.7 1.5 3 3.5"/>',
  star: '<path d="m12 4 2.2 5 5.3.4-4 3.4 1.3 5.2L12 15.3 7.2 18l1.3-5.2-4-3.4 5.3-.4L12 4Z" fill="#F2C55B"/>',
  pencil: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/>'
};
const KIND_ICON = {
  sunrise: 'sun', breakfast: 'cup', meal: 'bowl', noodles: 'bowl', setup: 'tent', camp: 'tent', bbq: 'pot', hotpot: 'pot',
  night: 'moon', explore: 'camera', games: 'cards', pack: 'box', cleanup: 'broom', depart: 'car', travel: 'car',
  market: 'basket', meet: 'people', activity: 'star'
};
// ---- hand-drawn doodle library (Japanese stationery / zakka style) ----
// Every doodle is drawn on a 48x48 grid: pastel fills printed slightly off-register (offset 1.6/1.4) under a round
// ~2px pen line, then the whole SVG gets a tiny wobble filter so the lines look hand-inked.
const D = {
  tent: { f: [['M6 40 24 8l18 32Z', '#F2C97A'], ['M19 40l5-14 5 14Z', '#E59A6B']], l: 'M6 40 24 8l18 32ZM24 8 17 40M24 8l7 32M19 40l5-14 5 14M3 40h42', x: '<circle cx="18" cy="30" r=".9" fill="currentColor"/><circle cx="30" cy="30" r=".9" fill="currentColor"/><path d="M21 33q3 2.4 6 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/>' },
  tree: { f: [['M24 6 37 30H11Z', '#9FBF92']], l: 'M24 6 37 30H11ZM24 30v11M17 22l7-9' },
  pine: { f: [['M24 5l8 12h-4l7 11H13l7-11h-4Z', '#A9C99B']], l: 'M24 5l8 12h-4l7 11H13l7-11h-4ZM24 28v13' },
  cloud: { f: [['M12 33c-6 0-8-8-3-10 0-7 9-9 12-3 3-5 12-3 12 4 6 0 7 9 1 9Z', '#FFFDF6']], l: 'M12 33c-6 0-8-8-3-10 0-7 9-9 12-3 3-5 12-3 12 4 6 0 7 9 1 9Z' },
  sun: { f: [['M24 15a9 9 0 1 0 .1 0Z', '#F2C55B']], l: 'M24 15a9 9 0 1 0 .1 0ZM24 3v5M24 40v5M3 24h5M40 24h5M9 9l3.5 3.5M35.5 35.5 39 39M9 39l3.5-3.5M35.5 12.5 39 9', x: '<circle cx="21" cy="23" r=".9" fill="currentColor"/><circle cx="27.5" cy="23" r=".9" fill="currentColor"/><path d="M22 27q2.5 2 5 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/>' },
  moon: { f: [['M31 8a17 17 0 1 0 11 27A14 14 0 0 1 31 8Z', '#F2C55B']], l: 'M31 8a17 17 0 1 0 11 27A14 14 0 0 1 31 8Z' },
  star: { f: [['M24 6l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1Z', '#F2C55B']], l: 'M24 6l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1Z' },
  mushroom: { f: [['M7 27c0-11 8-18 17-18s17 7 17 18Z', '#E98C73'], ['M18 27h12v11a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z', '#F6E6C8']], l: 'M7 27c0-11 8-18 17-18s17 7 17 18ZM18 27h12v11a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z', x: '<circle cx="16" cy="19" r="2.2" fill="#FFFDF6"/><circle cx="27" cy="15" r="2.6" fill="#FFFDF6"/><circle cx="33" cy="22" r="1.8" fill="#FFFDF6"/>' },
  campfire: { f: [['M24 6c3 6 11 10 11 20a11 11 0 0 1-22 0c0-6 4-8 5-13 2 2 3 3 6-7Z', '#F2A65A'], ['M24 20c2 4 5 6 5 10a5 5 0 0 1-10 0c0-3 3-4 5-10Z', '#F6D27A']], l: 'M24 6c3 6 11 10 11 20a11 11 0 0 1-22 0c0-6 4-8 5-13 2 2 3 3 6-7ZM8 42l32-6M8 36l32 6' },
  kettle: { f: [['M10 22h26v14a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6Z', '#BFD7DE']], l: 'M10 22h26v14a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6ZM36 26l7-4v8M8 22c2-8 24-8 26 0M17 12c0-2 2-2 2-4M24 12c0-2 2-2 2-4' },
  mug: { f: [['M9 18h23v17a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6Z', '#F4E4C8']], l: 'M9 18h23v17a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6ZM32 22h4a5 5 0 0 1 0 10h-4M15 12c0-3 3-3 3-6M23 12c0-3 3-3 3-6' },
  pot: { f: [['M8 22h32v10a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9Z', '#E98C73']], l: 'M8 22h32v10a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9ZM4 22h40M3 28l5 0M40 28h5M16 16c0-3 3-3 3-6M25 16c0-3 3-3 3-6M33 16c0-3 3-3 3-6', x: '<circle cx="18" cy="31" r=".9" fill="currentColor"/><circle cx="30" cy="31" r=".9" fill="currentColor"/><path d="M22 34q2 2 4 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/>' },
  lantern: { f: [['M15 14h18l3 7v14l-3 5H15l-3-5V21Z', '#F6D27A']], l: 'M15 14h18l3 7v14l-3 5H15l-3-5V21ZM19 8h10v6H19M20 8c0-5 8-5 8 0M24 20v12M18 27h12' },
  leaf: { f: [['M9 39C7 20 20 7 40 8c2 20-9 33-31 31Z', '#A9C99B']], l: 'M9 39C7 20 20 7 40 8c2 20-9 33-31 31ZM9 39 30 17M20 29l-1-8M26 23l7 0' },
  bird: { f: [], l: 'M6 26c5-8 11-8 15 0 4-8 10-8 15 0M30 12c3-4 7-4 9 0 2-4 6-4 8 0' },
  flower: { f: [['M24 8a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM10 20a7 7 0 1 1 13 4 7 7 0 0 1-13-4ZM38 20a7 7 0 1 0-13 4 7 7 0 0 0 13-4Z', '#F4B9B2'], ['M24 20a4 4 0 1 0 .1 0Z', '#F2C55B']], l: 'M24 8a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM24 22v20M24 34c-6 0-9-3-9-7 6 0 9 3 9 7ZM24 38c5 0 8-2 9-5-5 0-8 2-9 5Z' },
  acorn: { f: [['M14 22h20c0 12-5 20-10 20s-10-8-10-20Z', '#E9C99B'], ['M11 22c0-8 6-11 13-11s13 3 13 11Z', '#C99A6B']], l: 'M14 22h20c0 12-5 20-10 20s-10-8-10-20ZM11 22c0-8 6-11 13-11s13 3 13 11ZM24 11V6' },
  bear: { f: [['M8 12a6 6 0 1 1 11 3.5M40 12a6 6 0 1 0-11 3.5', '#D9A878'], ['M24 12c10 0 16 6 16 14s-7 15-16 15S8 34 8 26s6-14 16-14Z', '#D9A878'], ['M24 28a6 5 0 1 0 .1 0Z', '#F6E6C8']], l: 'M24 12c10 0 16 6 16 14s-7 15-16 15S8 34 8 26s6-14 16-14ZM8 12a6 6 0 1 1 11 3.5M40 12a6 6 0 1 0-11 3.5M24 28a6 5 0 1 0 .1 0Z', x: '<circle cx="17" cy="22" r="1.4" fill="currentColor"/><circle cx="31" cy="22" r="1.4" fill="currentColor"/><path d="M22 28h4l-2 2.5Z" fill="currentColor"/>' },
  rabbit: { f: [['M15 6c-3 0-4 10-2 16h8c1-6 0-16-6-16ZM33 6c3 0 4 10 2 16h-8c-1-6 0-16 6-16Z', '#FFFDF6'], ['M10 30c0-6 6-9 14-9s14 3 14 9-6 11-14 11-14-5-14-11Z', '#FFFDF6'], ['M15 9c-1 0-1 5 0 9M33 9c1 0 1 5 0 9', '#F4B9B2']], l: 'M15 6c-3 0-4 10-2 16h8c1-6 0-16-6-16ZM33 6c3 0 4 10 2 16h-8c-1-6 0-16 6-16ZM10 30c0-6 6-9 14-9s14 3 14 9-6 11-14 11-14-5-14-11Z', x: '<circle cx="18" cy="30" r="1.3" fill="currentColor"/><circle cx="30" cy="30" r="1.3" fill="currentColor"/><path d="M22 34q2 2 4 0" fill="none" stroke="currentColor" stroke-width=".8" stroke-linecap="round"/><circle cx="14" cy="34" r="2" fill="#F4B9B2" opacity=".7"/><circle cx="34" cy="34" r="2" fill="#F4B9B2" opacity=".7"/>' },
  van: { f: [['M5 33v-11l7-10h19l8 10h4v11Z', '#8EB4C9'], ['M13 15h7v7h-12Z', '#EAF3F5'], ['M23 15h7l5 7H23Z', '#EAF3F5']], l: 'M5 33v-11l7-10h19l8 10h4v11ZM8 22h35M23 12v10M12 12h19', x: '<circle cx="14" cy="34" r="4" fill="#FFFDF6" stroke="currentColor" stroke-width="1.4"/><circle cx="35" cy="34" r="4" fill="#FFFDF6" stroke="currentColor" stroke-width="1.4"/>' },
  cards: { f: [['M8 12h16v24H8Z', '#F4E4C8'], ['M20 10h18v26H20Z', '#FFFDF6']], l: 'M8 12h16v24H8ZM20 10h18v26H20ZM29 18v10M24 23h10' },
  sparkle: { f: [], l: 'M24 8v10M24 30v10M8 24h10M30 24h10M14 14l5 5M29 29l5 5M34 14l-5 5M19 29l-5 5' },
  skewer: { f: [['M30 5l12 12-6 6-12-12Z', '#FFFDF6'], ['M20 15l12 12-6 6-12-12Z', '#F6D7A8']], l: 'M30 5l12 12-6 6-12-12ZM20 15l12 12-6 6-12-12ZM14 33 5 43' },
};
Object.assign(D, {
  cat: { f: [['M8 20 9 6l9 7h12l9-7 1 14c0 10-7 16-16 16S8 30 8 20Z', '#F2D2A0']], l: 'M8 20 9 6l9 7h12l9-7 1 14c0 10-7 16-16 16S8 30 8 20ZM14 33 5 31M14 37 5 39M34 33l9-2M34 37l9 2', x: '<circle cx="18" cy="25" r="1.3" fill="currentColor"/><circle cx="30" cy="25" r="1.3" fill="currentColor"/><path d="M22 30h4l-2 2.4Z" fill="currentColor"/>' },
  fox: { f: [['M5 9l13 9h12l13-9-3 19c-2 8-8 14-16 14S10 36 8 28Z', '#E9A25F'], ['M15 34c3-7 15-7 18 0-3 6-15 6-18 0Z', '#FFFDF6']], l: 'M5 9l13 9h12l13-9-3 19c-2 8-8 14-16 14S10 36 8 28Z', x: '<circle cx="18" cy="27" r="1.3" fill="currentColor"/><circle cx="30" cy="27" r="1.3" fill="currentColor"/><path d="M22 34h4l-2 2.6Z" fill="currentColor"/>' },
  owl: { f: [['M10 12c5-5 23-5 28 0v22c0 6-6 10-14 10S10 40 10 34Z', '#C9A37A'], ['M12 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z', '#FFFDF6'], ['M24 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z', '#FFFDF6'], ['M22 25l2 5 2-5Z', '#F2A65A']], l: 'M10 12c5-5 23-5 28 0v22c0 6-6 10-14 10S10 40 10 34ZM10 12l-2-6 8 4M38 12l2-6-8 4M12 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM24 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z', x: '<circle cx="19" cy="21" r="1.6" fill="currentColor"/><circle cx="29" cy="21" r="1.6" fill="currentColor"/>' },
  hedgehog: { f: [['M5 36c0-14 8-24 20-24s16 10 16 24Z', '#B8956A'], ['M28 36c0-7 5-10 13-9l-1 9Z', '#F6E6C8']], l: 'M5 36c0-14 8-24 20-24s16 10 16 24ZM11 25l-5-3M16 18l-3-6M24 14l-1-7M32 16l3-7M37 22l6-4M28 36c0-7 5-10 13-9', x: '<circle cx="36" cy="31" r="1.2" fill="currentColor"/><circle cx="41" cy="30" r="1.6" fill="currentColor"/>' },
  duck: { f: [['M11 31c0-8 6-12 12-12 2-8 14-6 14 2 6 0 8 4 8 4s-3 3-8 3c0 10-8 16-17 16S11 40 11 31Z', '#F6D27A'], ['M37 21l8 3-8 3Z', '#F2A65A']], l: 'M11 31c0-8 6-12 12-12 2-8 14-6 14 2l8 3-8 3c0 10-8 16-17 16S11 40 11 31ZM18 34c4 4 10 3 13-2', x: '<circle cx="31" cy="19" r="1.4" fill="currentColor"/>' },
  frog: { f: [['M7 30c0-9 5-13 10-13 3 0 4 2 7 2s4-2 7-2c5 0 10 4 10 13 0 8-8 12-17 12S7 38 7 30Z', '#A9C99B'], ['M12 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0Z', '#FFFDF6'], ['M26 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0Z', '#FFFDF6']], l: 'M7 30c0-9 5-13 10-13 3 0 4 2 7 2s4-2 7-2c5 0 10 4 10 13 0 8-8 12-17 12S7 38 7 30ZM12 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0ZM26 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0ZM17 33q7 5 14 0', x: '<circle cx="17" cy="16" r="1.4" fill="currentColor"/><circle cx="31" cy="16" r="1.4" fill="currentColor"/>' },
  fish: { f: [['M5 24c8-11 24-11 30 0-6 11-22 11-30 0Z', '#8EB4C9'], ['M35 24l9-9v18Z', '#BFD7DE']], l: 'M5 24c8-11 24-11 30 0-6 11-22 11-30 0ZM35 24l9-9v18ZM24 15q4 9 0 18', x: '<circle cx="13" cy="22" r="1.3" fill="currentColor"/>' },
  butterfly: { f: [['M24 22C20 10 8 8 8 17s8 8 16 5Z', '#F4B9B2'], ['M24 22c4-12 16-14 16-5s-8 8-16 5Z', '#F4B9B2'], ['M24 24c-8 1-13 8-9 13s8-1 9-13Z', '#BFD7DE'], ['M24 24c8 1 13 8 9 13s-8-1-9-13Z', '#BFD7DE']], l: 'M24 22C20 10 8 8 8 17s8 8 16 5ZM24 22c4-12 16-14 16-5s-8 8-16 5ZM24 24c-8 1-13 8-9 13s8-1 9-13ZM24 24c8 1 13 8 9 13s-8-1-9-13ZM24 14v26M24 14l-4-6M24 14l4-6' },
  snail: { f: [['M15 22a11 11 0 1 0 22 0a11 11 0 1 0-22 0Z', '#E9C99B'], ['M4 38c0-5 4-5 9-5h31c0 7-6 9-14 9H8c-2 0-4-2-4-4Z', '#F6E6C8']], l: 'M15 22a11 11 0 1 0 22 0a11 11 0 1 0-22 0ZM21 22a5 5 0 1 0 10 0a4 4 0 0 0-7-3M4 38c0-5 4-5 9-5h31c0 7-6 9-14 9H8c-2 0-4-2-4-4ZM8 33v-8M13 33v-6' },
  bee: { f: [['M12 28a12 9 0 1 0 24 0a12 9 0 1 0-24 0Z', '#F6D27A'], ['M17 21c-5-11 6-14 9-6ZM27 21c3-9 14-8 10 1Z', '#DCEBEF']], l: 'M12 28a12 9 0 1 0 24 0a12 9 0 1 0-24 0ZM20 20v16M28 20v16M17 21c-5-11 6-14 9-6M27 21c3-9 14-8 10 1M36 24l6-3M10 26l-5 2', x: '<circle cx="15" cy="26" r="1.1" fill="currentColor"/>' },
  chair: { f: [['M15 6l4 20h18l-3-4H24l-3-16Z', '#8EB4C9']], l: 'M15 6l4 20h18l-3-4H24l-3-16ZM19 26l-5 16M33 22l5 20M19 26l15 16M33 22 17 42M12 6h5' },
  camera: { f: [['M5 16h38v24H5Z', '#BFD7DE'], ['M17 28a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z', '#FFFDF6']], l: 'M5 16h38v24H5ZM16 16l3-5h10l3 5M17 28a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z', x: '<circle cx="24" cy="28" r="2.4" fill="currentColor"/>' },
  backpack: { f: [['M11 15c0-7 4-9 13-9s13 2 13 9v24c0 3-2 5-5 5H16c-3 0-5-2-5-5Z', '#E59A6B'], ['M15 28h18v12H15Z', '#F2C97A']], l: 'M11 15c0-7 4-9 13-9s13 2 13 9v24c0 3-2 5-5 5H16c-3 0-5-2-5-5ZM15 28h18v12H15ZM19 6c0-3 2-4 5-4s5 1 5 4M24 28v5' },
  boots: { f: [['M10 6h13v20l12 4c4 1 7 3 7 7v5H10Z', '#C99A6B']], l: 'M10 6h13v20l12 4c4 1 7 3 7 7v5H10ZM10 38h32M10 14h13' },
  compass: { f: [['M7 24a17 17 0 1 0 34 0a17 17 0 1 0-34 0Z', '#FFFDF6'], ['M24 9l5 15h-10Z', '#E98C73'], ['M24 39l-5-15h10Z', '#8EB4C9']], l: 'M7 24a17 17 0 1 0 34 0a17 17 0 1 0-34 0ZM24 9l5 15h-10ZM24 39l-5-15h10ZM24 3v4M24 41v4' },
  map: { f: [['M5 10l13 4 12-4 13 4v26l-13-4-12 4-13-4Z', '#F6E6C8']], l: 'M5 10l13 4 12-4 13 4v26l-13-4-12 4-13-4ZM18 14v26M30 10v26M22 30l4-6 4 3 5-8', x: '<circle cx="35" cy="19" r="1.5" fill="#E98C73"/>' },
  binoculars: { f: [['M5 18h15v24H5ZM28 18h15v24H28Z', '#8EB4C9'], ['M20 24h8v10h-8Z', '#BFD7DE']], l: 'M5 18h15v24H5ZM28 18h15v24H28ZM20 24h8v10h-8ZM8 18v-6h9v6M31 18v-6h9v6' },
  thermos: { f: [['M15 12h18v31H15Z', '#BFD7DE'], ['M14 6h20v6H14Z', '#E59A6B']], l: 'M15 12h18v31H15ZM14 6h20v6H14ZM15 22h18' },
  hat: { f: [['M4 33c0-4 10-6 20-6s20 2 20 6-10 7-20 7S4 37 4 33Z', '#F2C97A'], ['M13 29c0-13 4-19 11-19s11 6 11 19Z', '#F2C97A'], ['M13 27h22v4H13Z', '#E59A6B']], l: 'M4 33c0-4 10-6 20-6s20 2 20 6-10 7-20 7S4 37 4 33ZM13 29c0-13 4-19 11-19s11 6 11 19M13 27h22' },
  umbrella: { f: [['M4 25C6 8 42 8 44 25Z', '#F4B9B2']], l: 'M4 25C6 8 42 8 44 25ZM4 25q5-4 10 0t10 0 10 0 10 0M24 25v14a4 4 0 0 1-8 0M24 6V3' },
  kite: { f: [['M24 3l14 17-14 22L10 20Z', '#F4B9B2']], l: 'M24 3l14 17-14 22L10 20ZM24 3v39M10 20h28M24 42c-4 2-4 4 0 6s4 3 0 5' },
  bread: { f: [['M5 28c0-13 11-19 19-19s19 6 19 19v11H5Z', '#E9C99B']], l: 'M5 28c0-13 11-19 19-19s19 6 19 19v11H5ZM14 19l4 8M24 16l4 8M33 19l4 8' },
  onigiri: { f: [['M24 5c8 8 17 20 17 29 0 5-4 8-9 8H16c-5 0-9-3-9-8C7 25 16 13 24 5Z', '#FFFDF6'], ['M15 30h18v12H15Z', '#4B5D52']], l: 'M24 5c8 8 17 20 17 29 0 5-4 8-9 8H16c-5 0-9-3-9-8C7 25 16 13 24 5ZM15 30h18v12H15Z' },
  bento: { f: [['M4 12h40v28H4Z', '#F6E6C8'], ['M8 16h15v20H8Z', '#FFFDF6'], ['M27 16h13v9H27Z', '#F6D27A'], ['M27 28h13v8H27Z', '#A9C99B']], l: 'M4 12h40v28H4ZM8 16h15v20H8ZM27 16h13v9H27ZM27 28h13v8H27Z' },
  teapot: { f: [['M9 22h26v13a8 8 0 0 1-8 8H17a8 8 0 0 1-8-8Z', '#A9C99B']], l: 'M9 22h26v13a8 8 0 0 1-8 8H17a8 8 0 0 1-8-8ZM9 27H5c0-5 2-7 6-7M35 26h4a4 4 0 0 1 0 9h-4M16 22c0-6 2-9 6-9s6 3 6 9M22 13v-3' },
  dango: { f: [['M18 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z', '#F4B9B2'], ['M18 25a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z', '#FFFDF6'], ['M18 38a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z', '#A9C99B']], l: 'M24 2v44M18 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM18 25a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM18 38a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z' },
  watermelon: { f: [['M5 20a19 19 0 0 0 38 0Z', '#E98C73'], ['M5 20a19 19 0 0 0 38 0c-3 4-8 8-19 8S8 24 5 20Z', '#A9C99B']], l: 'M5 20h38M5 20a19 19 0 0 0 38 0', x: '<ellipse cx="17" cy="23" rx="1.1" ry="1.8" fill="currentColor"/><ellipse cx="24" cy="25" rx="1.1" ry="1.8" fill="currentColor"/><ellipse cx="31" cy="23" rx="1.1" ry="1.8" fill="currentColor"/>' },
  icecream: { f: [['M14 22 24 45l10-23Z', '#E9C99B'], ['M11 24a13 13 0 0 1 26 0Z', '#F4B9B2'], ['M15 14a9 9 0 0 1 18 0Z', '#FFFDF6']], l: 'M14 22 24 45l10-23ZM11 24a13 13 0 0 1 26 0ZM15 14a9 9 0 0 1 18 0ZM17 28l7 12M31 28l-7 12' },
  rainbow: { f: [['M4 38a20 20 0 0 1 40 0h-6a14 14 0 0 0-28 0Z', '#F4B9B2'], ['M10 38a14 14 0 0 1 28 0h-6a8 8 0 0 0-16 0Z', '#F6D27A'], ['M16 38a8 8 0 0 1 16 0h-5a3 3 0 0 0-6 0Z', '#BFD7DE']], l: 'M4 38a20 20 0 0 1 40 0M10 38a14 14 0 0 1 28 0M16 38a8 8 0 0 1 16 0' },
  bamboo: { f: [['M16 4h7v40h-7ZM29 10h7v34h-7Z', '#A9C99B']], l: 'M16 4h7v40h-7ZM29 10h7v34h-7ZM16 16h7M16 28h7M29 20h7M29 32h7M23 14c6-1 10-5 12-9M16 24c-6-1-10-5-12-9' },
  sakura: { f: [['M17 13a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM28 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM6 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z', '#F8CFD2'], ['M20.5 26a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0Z', '#F2C55B']], l: 'M17 13a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM28 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM6 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z' },
  maple: { f: [['M24 3l4 10 8-4-2 11 10 2-8 7 4 8-10-1-2 8-4-6-4 6-2-8-10 1 4-8-8-7 10-2-2-11 8 4Z', '#E98C73']], l: 'M24 3l4 10 8-4-2 11 10 2-8 7 4 8-10-1-2 8-4-6-4 6-2-8-10 1 4-8-8-7 10-2-2-11 8 4ZM24 44V28' },
  ginkgo: { f: [['M24 40V29C9 29 5 18 7 9c6 4 11 2 17 7 6-5 11-3 17-7 2 9-2 20-17 20Z', '#F6D27A']], l: 'M24 44V29C9 29 5 18 7 9c6 4 11 2 17 7 6-5 11-3 17-7 2 9-2 20-17 20ZM24 16v13' },
  sunflower: { f: [['M24 3l4 8 8-4 0 9 9 0-5 8 7 6-9 2 2 9-8-3-3 8-5-7-5 7-3-8-8 3 2-9-9-2 7-6-5-8 9 0 0-9 8 4Z', '#F6D27A'], ['M14 24a10 10 0 1 0 20 0a10 10 0 1 0-20 0Z', '#C99A6B']], l: 'M24 3l4 8 8-4 0 9 9 0-5 8 7 6-9 2 2 9-8-3-3 8-5-7-5 7-3-8-8 3 2-9-9-2 7-6-5-8 9 0 0-9 8 4ZM14 24a10 10 0 1 0 20 0a10 10 0 1 0-20 0Z' },
  tulip: { f: [['M13 6c0 11 3 19 11 19s11-8 11-19l-6 4-5-6-5 6Z', '#F4B9B2'], ['M24 40c-8 0-12-5-12-10 8 0 12 4 12 10Z', '#A9C99B']], l: 'M13 6c0 11 3 19 11 19s11-8 11-19l-6 4-5-6-5 6ZM24 25v20M24 40c-8 0-12-5-12-10 8 0 12 4 12 10Z' },
  clover: { f: [['M10 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z', '#A9C99B']], l: 'M10 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 24l-5 21' },
  pinecone: { f: [['M24 5c9 0 13 8 13 19s-4 19-13 19-13-8-13-19S15 5 24 5Z', '#C99A6B']], l: 'M24 5c9 0 13 8 13 19s-4 19-13 19-13-8-13-19S15 5 24 5ZM13 16q11 6 22 0M12 25q12 7 24 0M14 34q10 6 20 0M24 5v38' },
  cherry: { f: [['M6 34a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM26 36a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z', '#E98C73'], ['M30 6c6-2 11 0 13 5-6 2-11 0-13-5Z', '#A9C99B']], l: 'M6 34a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM26 36a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM14 26C17 15 23 8 30 6M33 29C32 19 31 11 30 6M30 6c6-2 11 0 13 5-6 2-11 0-13-5Z' },
  hammock: { f: [['M5 22c6 14 32 14 38 0Z', '#F4B9B2']], l: 'M5 8v36M43 8v36M5 22c6 14 32 14 38 0M5 22h38M10 44h-10M48 44H38' }
});
const BIG_CAMP = ['tent', 'tent', 'campfire', 'hammock'];
const ANIMALS = ['bear', 'rabbit', 'cat', 'fox', 'owl', 'hedgehog', 'duck', 'frog', 'fish', 'butterfly', 'snail', 'bee'];
const PLANTS = ['tree', 'pine', 'flower', 'mushroom', 'leaf', 'acorn', 'bamboo', 'sakura', 'maple', 'ginkgo', 'sunflower', 'tulip', 'clover', 'pinecone', 'cherry'];
const GEAR = ['lantern', 'kettle', 'mug', 'chair', 'camera', 'backpack', 'boots', 'compass', 'map', 'binoculars', 'thermos', 'hat', 'umbrella', 'cards', 'skewer'];
const FOOD = ['onigiri', 'bento', 'dango', 'watermelon', 'icecream', 'bread', 'teapot', 'mug'];
const SKY = ['cloud', 'cloud', 'rainbow', 'bird', 'star', 'sparkle', 'butterfly', 'kite'];
const SMALL = [...new Set([...ANIMALS, ...PLANTS, ...GEAR, ...FOOD, 'bird', 'star', 'sparkle', 'cloud', 'rainbow', 'kite'])];

function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pickFrom = (rand, a) => a[Math.floor(rand() * a.length)];

function doodle(name, x, y, s = 1, r = 0, cls = '') {
  const d = D[name]; if (!d) return '';
  const fills = d.f.map(([p, c]) => `<path d="${p}" fill="${c}"/>`).join('');
  const g = `<g transform="translate(${x} ${y}) rotate(${r} ${24 * s} ${24 * s}) scale(${s})"><g transform="translate(1.6 1.4)">${fills}</g><path d="${d.l}" fill="none" stroke="currentColor" stroke-width="${(2 / s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>${d.x || ''}</g>`;
  return cls ? `<g class="${cls}">${g}</g>` : g;
}
const sceneSvg = (w, h, body) => `<svg class="j-wob" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" color="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;
const groundPath = (rand, w, y, wd) => { const j = () => (rand() * 10 - 5).toFixed(1); return `<path d="M6 ${y}c${w * .18} ${j()} ${w * .32} ${j()} ${w * .5} ${j()}s${w * .3} ${j()} ${w * .44} ${j()}" fill="none" stroke="#C8D5BC" stroke-width="${wd}" stroke-linecap="round"/>`; };

const shuffled = (rand, a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const distinct = (rand, pool, n, avoid = []) => shuffled(rand, pool.filter(x => !avoid.includes(x))).slice(0, n);
const GROUND = [...ANIMALS, ...PLANTS, ...GEAR];
/** Header scene (300x134): random main motif, one of three layouts, with random sky and ground friends. */
function headerScene(rand) {
  const rot = () => Math.round(rand() * 12 - 6);
  const main = pickFrom(rand, ['tent', 'tent', 'van', 'campfire', 'hammock']);
  const layout = Math.floor(rand() * 3);
  const mainX = [86, 24, 178][layout];
  const friendSpots = [[[14, 66, 1.05], [236, 66, 1.05], [62, 96, .62], [206, 98, .62]],
    [[150, 70, .95], [196, 62, 1.0], [242, 70, .95], [112, 98, .55]],
    [[10, 70, .95], [58, 62, 1.0], [106, 70, .95], [262, 98, .55]]][layout];
  const friends = distinct(rand, GROUND, friendSpots.length);
  const sx = shuffled(rand, [14, 116, 218]);
  const skyPick = distinct(rand, SKY, 2);
  let svg = groundPath(rand, 288, 116, 14);
  svg += doodle('sun', sx[0], 2, .95, 0, 'j-sun') + doodle('moon', sx[0], 2, .95, 0, 'j-moon');
  svg += doodle(skyPick[0], sx[1], 4 + Math.round(rand() * 8), .8, rot()) + doodle(skyPick[1], sx[2], 8 + Math.round(rand() * 8), .7, rot());
  svg += doodle(main, mainX, 14, 2.3, rot() / 2);
  friendSpots.forEach(([x, y, s], i) => { svg += doodle(friends[i], x, y, s, rot()); });
  return sceneSvg(300, 134, svg);
}
/** Day art for a day with routes (camp) and for a day with only activities (life): random main + friends, two layouts. */
function dayScene(rand, mains, pools, w = 180, h = 104) {
  const main = pickFrom(rand, mains), flip = rand() < .5;
  const [a, b] = distinct(rand, pools, 2), top = pickFrom(rand, SKY);
  const mx = flip ? 100 : 40, ax = flip ? 8 : 128, bx = flip ? 52 : 150;
  return sceneSvg(w, h, groundPath(rand, w - 10, 94, 8) + doodle(main, mx, 8, 1.75, Math.round(rand() * 6 - 3)) +
    doodle(a, ax, 46, .9, Math.round(rand() * 12 - 6)) + doodle(b, flip ? 20 : bx, 60, .6, Math.round(rand() * 14 - 7)) + doodle(top, flip ? 12 : 128, 2, .55, 8));
}
const campScene = rand => dayScene(rand, BIG_CAMP, [...PLANTS, ...ANIMALS, 'lantern', 'chair', 'kettle', 'boots', 'backpack']);
const lifeScene = rand => dayScene(rand, ['pot', 'pot', 'teapot', 'bento', 'watermelon', 'icecream', 'dango'], [...ANIMALS, ...FOOD, ...PLANTS, 'cards', 'mug', 'camera']);
/** A loose row of tiny doodles along the bottom edge of a day card. */
function doodleStrip(rand, n = 5) {
  const names = distinct(rand, SMALL, n);
  return sceneSvg(n * 40, 38, names.map((nm, i) => doodle(nm, i * 40 + 2, 2, .66, Math.round(rand() * 20 - 10))).join(''));
}const WOBBLE = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><filter id="j-wobble" x="-6%" y="-6%" width="112%" height="112%"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4"/></filter></svg>';
let shuffleBump = 0;
const WEEK = '日一二三四五六';
function mdw(date, long = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return date || '日期未填';
  const w = WEEK[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${+m[2]}/${+m[3]}（${long ? '週' : ''}${w}）`;
}

export function renderJournal(container, plan, ctx) {
  const { M, placeName, vehicleName, eventTitle, isMealEvent, label, canEdit, onEditDay, onCopy } = ctx;
  // Random but stable: the doodles depend on the trip and on the shuffle counter, not on every re-render.
  const seedBase = `${plan.title}|${(plan.days[0] || {}).date || ''}|${shuffleBump}`;
  const R = key => rng(hashStr(seedBase + '#' + key));
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v;
      else if (k === 'html') n.append(document.createRange().createContextualFragment(v));
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  };
  const icon = (name, cls = 'j-icon') => el('span', { class: cls, html: SVG(ICONS[name] || ICONS.star) });
  const carIcon = color => { const s = icon('car', 'j-car'); s.style.color = color || '#83accc'; return s; };
  const kindName = k => label(M.KINDS[k] || k);
  const stopName = k => label((M.STOP_KINDS || {})[k] || k);

  // ----- header -----
  const dest = plan.days.map(d => d.locationId).find(Boolean);
  const head = el('header', { class: 'j-head' },
    el('div', { class: 'j-head-copy' },
      el('span', { class: 'j-eyebrow' }, el('span', { class: 'j-eye-light', text: 'CAMPING JOURNAL' }), el('span', { class: 'j-eye-dark', text: 'UNDER THE STARS' })),
      el('div', { class: 'j-title', text: plan.headline || plan.title || '未命名旅程' }),
      el('p', { class: 'j-dates', text: plan.days.map(d => mdw(d.date, false)).join('・') || '日期未填' }),
      el('p', { class: 'j-sub', text: `露營行程手帖 ／ 地點：${dest ? placeName(dest) : '未指定'}` }),
      plan.vehicles.length ? el('ul', { class: 'j-cars', 'aria-label': '車輛' }, plan.vehicles.map(v => el('li', {}, carIcon(v.color), el('span', { text: v.name })))) : null),
    el('div', { class: 'j-head-art', html: headerScene(R('head')) }, el('span', { class: 'j-head-note', text: plan.caption || '一起慢慢度日' })));

  // ----- one day -----
  const routeItem = r => {
    const parts = [placeName(r.from), ...(r.stops || []).map(s => `${placeName(s.placeId)}（${stopName(s.kind)}・${s.time || '時間未填'}）`), placeName(r.to)];
    const items = (r.stops || []).flatMap(s => s.kind === 'shopping' && s.items.length ? [`要買：${s.items.join('、')}`] : []);
    return el('li', { class: 'j-route' },
      el('div', { class: 'j-route-top' }, carIcon((plan.vehicles.find(v => v.id === r.vehicleId) || {}).color),
        el('b', { text: vehicleName(r.vehicleId) }), el('span', { class: 'j-route-time', text: r.departure ? `${r.departure} 出發` : '出發時間未填' })),
      el('p', { class: 'j-route-path', text: parts.join(' → ') }),
      items.map(t => el('p', { class: 'j-route-note', text: t })));
  };
  const eventItem = e => el('li', { class: 'j-event' },
    el('span', { class: 'j-event-time', text: e.time || '—' }), icon(KIND_ICON[e.kind] || 'star'),
    el('span', { class: 'j-event-body' }, el('span', { class: 'j-event-title', text: eventTitle(e) }),
      isMealEvent(e) ? el('span', { class: 'j-tag', text: '餐點' }) : el('span', { class: 'j-kind', text: kindName(e.kind) }),
      e.notes ? el('span', { class: 'j-event-note', text: e.notes }) : null));

  const days = plan.days.map((d, i) => {
    // Return day: routes set to run after the day's activities, or the last day where every car leaves from where it stayed.
    const after = d.routePosition === 'after' || (i === plan.days.length - 1 && i > 0 && d.routes.length > 0 && !!d.locationId && d.routes.every(r => r.from === d.locationId));
    const routes = d.routes.length ? el('section', { class: 'j-col' },
      el('h4', { class: 'j-col-title', text: after ? '回程路線' : '去程路線' }),
      el('ul', { class: 'j-list' }, d.routes.map(routeItem)),
      d.arrivalLabel ? el('p', { class: 'j-small', text: `抵達：${d.arrivalLabel}` }) : null,
      (() => { const miss = plan.vehicles.filter(v => !d.routes.some(r => r.vehicleId === v.id)).map(v => v.name);
        return miss.length ? el('p', { class: 'j-small', text: `${miss.join('、')}：還沒有${after ? '回程' : '去程'}路線` }) : null; })()) : null;
    const events = el('section', { class: 'j-col' },
      el('h4', { class: 'j-col-title', text: after ? '收帳與返程' : d.routes.length ? '營地活動' : '今天的安排' }),
      d.events.length ? el('ul', { class: 'j-list' }, d.events.map(eventItem)) : el('p', { class: 'j-small', text: '這一天留白，慢慢安排。' }));
    const art = el('div', { class: 'j-art', html: d.routes.length ? (after ? '' : campScene(R('camp' + i))) : lifeScene(R('life' + i)) });
    if (after && d.routes.length) art.classList.add('cars');
    if (after && d.routes.length) art.append(el('div', { class: 'j-art-cars' }, d.routes.map(r => carIcon((plan.vehicles.find(v => v.id === r.vehicleId) || {}).color))));
    const cols = after ? [events, routes] : [routes, events];
    return el('article', { class: `j-day tone-${i % 3}${d.routes.length ? ' two' : ''}`, 'aria-labelledby': `j-day-${i}` },
      el('span', { class: 'j-tape', 'aria-hidden': 'true' }),
      el('header', { class: 'j-day-head' },
        el('span', { class: 'j-day-no', text: `DAY ${i + 1}` }), el('span', { class: 'j-day-date', text: mdw(d.date) }),
        canEdit && onEditDay ? el('button', { type: 'button', class: 'j-edit', title: '編輯這一天', 'aria-label': `編輯第 ${i + 1} 天`, onclick: () => onEditDay(i), html: SVG(ICONS.pencil) }) : null),
      el('h3', { class: 'j-day-title', id: `j-day-${i}`, text: d.title || '未命名的一天' }),
      el('p', { class: 'j-small', text: `地點：${d.locationId ? placeName(d.locationId) : '未指定'}` }),
      el('div', { class: 'j-cols' }, cols.filter(Boolean), art),
      el('div', { class: 'j-strip', html: doodleStrip(R('strip' + i), after ? 4 : 5) }));
  });

  // ----- unassigned shopping -----
  const shop = plan.shopping.length ? el('section', { class: 'j-shop', 'aria-labelledby': 'j-shop-title' },
    el('span', { class: 'j-tape right', 'aria-hidden': 'true' }),
    el('div', { class: 'j-shop-head' }, icon('basket', 'j-shop-icon'),
      el('div', {}, el('h3', { id: 'j-shop-title', text: '未分配採買清單' }), el('p', { class: 'j-small', text: '先把清單帶上，再一起分工。' }))),
    el('ul', { class: 'j-shop-list' }, plan.shopping.map(s => el('li', {}, el('span', { class: 'j-box', 'aria-hidden': 'true' }), el('span', { text: s }))))) : null;

  const tools = el('div', { class: 'j-tools' },
    el('button', { type: 'button', class: 'j-copy j-shuffle', title: '換一組小圖案', 'aria-label': '換一組小圖案', onclick: () => { shuffleBump += 1; renderJournal(container, plan, ctx); },
      html: SVG('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/>') }),
    el('button', { type: 'button', id: 'copyItinerary', class: 'j-copy', title: '複製文字版行程', 'aria-label': '複製文字版行程', onclick: onCopy, html: SVG(ICONS.copy) }, el('span', { class: 'copy-label', text: '複製文字' })));

  container.replaceChildren(el('span', { html: WOBBLE }), tools, head, el('div', { class: 'j-days' }, days), shop,
    el('div', { class: 'j-foot' }, el('span', { text: '時間未填的項目，之後再補上就好。' }), el('span', { text: 'HAVE A LITTLE GOOD DAY' })));
}