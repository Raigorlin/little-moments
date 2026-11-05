import { illustration } from './art.js';

export const SCENE_MOTION_KEY = 'ggc-scene-motion';
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const TOGGLE = '[data-scene-motion-toggle]';
const REDUCED_NOTE = '[data-motion-reduced-note]';

let env = null;
let paused = false;
let memoryPreference = null;

function readPreference(storage) {
  try {
    const value = storage?.getItem(SCENE_MOTION_KEY);
    if (value === 'paused' || value === 'playing') return value;
  } catch {}
  return memoryPreference;
}

function writePreference(storage, value) {
  memoryPreference = value;
  try { storage?.setItem(SCENE_MOTION_KEY, value); } catch {}
}

function prefersReduced(query) {
  return !!query?.matches;
}

const toggleLabel = state => state === 'paused' ? '播放動畫' : '暫停動畫';

export function sceneMotionState() {
  if (!env) return 'static';
  if (prefersReduced(env.query)) return 'reduced';
  return paused ? 'paused' : 'running';
}

export function syncSceneMotion() {
  if (!env) return 'static';
  paused = readPreference(env.storage) === 'paused';
  const state = sceneMotionState();
  env.root.dataset.sceneMotion = state;
  for (const button of env.doc.querySelectorAll(TOGGLE)) {
    button.hidden = state === 'reduced';
    button.setAttribute('aria-label', toggleLabel(state));
  }
  for (const note of env.doc.querySelectorAll(REDUCED_NOTE)) note.hidden = state !== 'reduced';
  return state;
}

export function setSceneMotionPaused(value) {
  if (!env) return 'static';
  writePreference(env.storage, value ? 'paused' : 'playing');
  return syncSceneMotion();
}

export function setupSceneMotion(options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc) return 'static';
  if (env?.doc === doc) return syncSceneMotion();
  if (env) teardownSceneMotion();
  const win = options.window ?? doc.defaultView ?? globalThis;
  let storage = options.storage;
  if (storage === undefined) { try { storage = win.localStorage; } catch { storage = null; } }
  const query = options.reducedMotion ?? win.matchMedia?.(REDUCED_QUERY) ?? null;
  const onClick = event => {
    const button = event.target?.closest?.(TOGGLE);
    if (!button || sceneMotionState() === 'reduced') return;
    event.preventDefault();
    setSceneMotionPaused(!paused);
  };
  const onStorage = event => { if (event.key === null || event.key === SCENE_MOTION_KEY) syncSceneMotion(); };
  const onQuery = () => syncSceneMotion();
  doc.addEventListener('click', onClick);
  win.addEventListener?.('storage', onStorage);
  query?.addEventListener?.('change', onQuery);
  env = { doc, win, root: doc.documentElement, storage, query, onClick, onStorage, onQuery };
  return syncSceneMotion();
}

export function teardownSceneMotion() {
  if (!env) return;
  env.doc.removeEventListener('click', env.onClick);
  env.win.removeEventListener?.('storage', env.onStorage);
  env.query?.removeEventListener?.('change', env.onQuery);
  delete env.root.dataset.sceneMotion;
  env = null;
  paused = false;
  memoryPreference = null;
}

const PAUSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="scene-motion__icon scene-motion__icon--pause"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" class="scene-motion__icon scene-motion__icon--play"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8-5.2a.6.6 0 0 0 0-1l-8-5.2a.6.6 0 0 0-.9.5Z"/></svg>';

export function animatedIllustration(kind = 'camp', options = {}) {
  const safeKind = String(kind).replace(/[^a-z]/g, '') || 'camp';
  return `<div class="scene-motion illustration scene-motion--${safeKind}">${illustration(kind, '', options)}</div>`;
}

export function sceneMotionSettings() {
  const state = sceneMotionState();
  const reduced = state === 'reduced';
  return `<section class="motion-settings" aria-label="插畫動畫"><div class="motion-settings__copy"><h3>插畫動畫</h3><p>控制車子與背景動態，只影響這台裝置。</p><p class="motion-settings__note" data-motion-reduced-note${reduced ? '' : ' hidden'}>依系統減少動態設定，插畫保持靜態。</p></div><button type="button" class="scene-motion__toggle" data-scene-motion-toggle aria-label="${toggleLabel(state)}"${reduced ? ' hidden' : ''}>${PAUSE_ICON}${PLAY_ICON}<span class="scene-motion__label scene-motion__label--pause">暫停動畫</span><span class="scene-motion__label scene-motion__label--play">播放動畫</span></button></section>`;
}
