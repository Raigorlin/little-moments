import { enableSwipeActions } from './mobile-swipe.js';

enableSwipeActions();
if (location.pathname === '/demo' || location.pathname.startsWith('/demo/')) {
  await import('./app.js');
} else {
  await import('./accounts-ui.js');
}
// Register after the page has loaded so the service worker's precache does not compete with the first render.
if ('serviceWorker' in navigator) { const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {}); if (document.readyState === 'complete') register(); else addEventListener('load', register, { once: true }); }
