'use strict';

// Notifications contain no tool arguments, paths, prompts, or provider keys.
function createAttention({ Notification, app, shell, getWindow, now = Date.now }) {
  const pending = new Map();
  let lastShown = -Infinity;
  const badge = () => app.dock?.setBadge(pending.size ? String(pending.size) : '');
  function request(id, kind) {
    if (pending.has(id)) return;
    pending.set(id, null);
    badge();
    const win = getWindow();
    if (!win || win.isDestroyed() || win.isFocused() && !win.isMinimized() || now() - lastShown < 2000) return;
    lastShown = now();
    try {
      if (Notification.isSupported()) {
        const notification = new Notification({ title: 'Reach Studio needs your review',
          body: kind === 'edit' ? 'An agent has proposed file changes. Accept or reject them in Studio.' : 'An agent is waiting for your approval.', silent: true });
        notification.on('click', () => {
          const target = getWindow();
          if (!target || target.isDestroyed()) return;
          if (target.isMinimized()) target.restore();
          target.show(); target.focus();
        });
        pending.set(id, notification);
        notification.show();
      }
      shell.beep();
    } catch { /* Notification permissions must never block the approval flow. */ }
  }
  function resolve(id) {
    pending.get(id)?.close();
    pending.delete(id);
    badge();
  }
  return { request, resolve };
}
module.exports = { createAttention };
