const ROW_SELECTOR = '[data-swipe-row]';
const ACTION_SELECTOR = [
  '[data-action="activity"]', '[data-action="meal"]', '[data-action="shopping"]',
  '[data-action="gear"]', '[data-action="vehicle"]', '[data-action="person"]', '[data-action="delete"]',
  '[data-action^="acct-edit-"]', '[data-action^="acct-delete-"]',
  '[data-xp="edit-expense"]', '[data-xp="ask-remove-expense"]',
  '[data-xp="ask-remove-settlement"]'
].join(',');
const SWIPE_THRESHOLD = 42;
const OPEN_THRESHOLD = 56;

export function enableSwipeActions(root = document.body) {
  let start = null;
  let suppressClickUntil = 0;
  const rows = new Set();
  const touchLayout = matchMedia('(max-width: 760px)');

  function closeRows(except = null) {
    for (const row of rows) {
      if (row !== except) setOpen(row, false);
    }
  }
  function setOpen(row, open) {
    row.classList.toggle('swipe-open', open);
    row.querySelector('.swipe-actions')?.setAttribute('aria-hidden', String(!open));
    row.querySelector('.swipe-toggle')?.setAttribute('aria-expanded', String(open));
  }
  function prepare(row) {
    if (row.dataset.swipeReady === 'true') return;
    const controls = [...row.querySelectorAll(ACTION_SELECTOR)];
    const sourceButtons = controls.filter(button => !button.disabled);
    if (!sourceButtons.length) return;
    const panel = document.createElement('div');
    panel.className = 'swipe-actions';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '滑動操作');
    panel.setAttribute('aria-hidden', 'true');
    for (const button of sourceButtons) {
      const copy = button.cloneNode(true);
      const label = button.getAttribute('aria-label') || button.textContent.trim();
      const swipeLabel = /編輯/.test(label) ? '編輯' : /移除|刪除/.test(label) ? '刪除' : '操作';
      const icons = [...copy.querySelectorAll('svg')];
      copy.replaceChildren(...icons);
      copy.removeAttribute('id');
      copy.setAttribute('aria-label', label || swipeLabel);
      copy.dataset.swipeLabel = swipeLabel;
      copy.classList.add('swipe-action');
      if (button.classList.contains('danger') || swipeLabel === '刪除') {
        copy.classList.add('swipe-action-danger');
      }
      panel.append(copy);
    }
    controls.forEach(button => { button.dataset.swipeOriginal = 'true'; });
    row.style.setProperty('--swipe-count', String(panel.children.length));
    row.append(panel);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'swipe-toggle';
    toggle.setAttribute('aria-label', '顯示編輯與刪除操作');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '‹';
    row.append(toggle);
    row.dataset.swipeReady = 'true';
    row.classList.add('swipe-row');
    rows.add(row);
  }
  function scan(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(ROW_SELECTOR)) prepare(node);
    node.querySelectorAll(ROW_SELECTOR).forEach(prepare);
    for (const row of rows) if (!row.isConnected) rows.delete(row);
  }

  scan(root);
  const observer = new MutationObserver(records => records.forEach(record => {
    record.addedNodes.forEach(scan);
    if (record.type === 'attributes' && record.target.matches?.(ROW_SELECTOR)) prepare(record.target);
  }));
  observer.observe(root, { subtree: true, childList: true });

  function onPointerDown(event) {
    suppressClickUntil = 0;
    if (!touchLayout.matches || !['touch', 'pen'].includes(event.pointerType)) return;
    const row = event.target.closest?.(`${ROW_SELECTOR}.swipe-row`);
    if (!row || event.target.closest('button,a,input,select,textarea,summary')) return;
    start = { row, x: event.clientX, y: event.clientY };
  }
  function onPointerUp(event) {
    if (!start) return;
    const { row, x, y } = start;
    start = null;
    const dx = event.clientX - x, dy = event.clientY - y;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    if (dx < -SWIPE_THRESHOLD && Math.abs(dx) >= OPEN_THRESHOLD) {
      closeRows(row);
      setOpen(row, true);
    } else if (dx > SWIPE_THRESHOLD) {
      setOpen(row, false);
    }
    suppressClickUntil = performance.now() + 450;
  }
  function onPointerCancel() { start = null; }
  function onClick(event) {
    const toggle = event.target.closest?.('.swipe-toggle');
    if (toggle) {
      const row = toggle.closest(ROW_SELECTOR);
      closeRows(row);
      setOpen(row, !row.classList.contains('swipe-open'));
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (performance.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.target.closest('.swipe-actions')) closeRows();
  }
  function onLayoutChange() { closeRows(); }

  touchLayout.addEventListener('change', onLayoutChange);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', onPointerCancel, true);
  root.addEventListener('click', onClick, true);
  return () => {
    observer.disconnect();
    touchLayout.removeEventListener('change', onLayoutChange);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', onPointerCancel, true);
    root.removeEventListener('click', onClick, true);
  };
}
