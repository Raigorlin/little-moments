import { enableSwipeActions } from './mobile-swipe.js';

enableSwipeActions();
// server/http.js injects this meta tag only in Published_Mode; the Local_Planner is local-only.
const published = document.querySelector('meta[name="camping-deployment"]')?.content === 'published';
const demo = location.pathname === '/demo' || location.pathname.startsWith('/demo/');
if (demo && !published) {
  await import('./app.js');
} else {
  await import('./accounts-ui.js');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
