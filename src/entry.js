import { enableSwipeActions } from './mobile-swipe.js';

enableSwipeActions();
if (location.pathname === '/demo' || location.pathname.startsWith('/demo/')) {
  await import('./app.js');
} else {
  await import('./accounts-ui.js');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
