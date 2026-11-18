let observer = null;

// Pause decorative animation for poster days fully outside the viewport (Requirement 12.7).
export function watchPosterDays(root = document) {
  if (observer) { observer.disconnect(); observer = null; }
  if (typeof IntersectionObserver !== 'function' || !root) return;
  const days = root.querySelectorAll('[data-poster-day]');
  if (!days.length) return;
  const current = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const visible = entry.isIntersecting || entry.intersectionRatio > 0;
      if (visible) entry.target.removeAttribute('data-offscreen');
      else entry.target.setAttribute('data-offscreen', '');
    }
  });
  observer = current;
  days.forEach(day => current.observe(day));
}
