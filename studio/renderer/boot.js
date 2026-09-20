/* Renderer boot-time error capture.
 *
 * This was an inline <script> in index.html; it is now a file so the CSP can
 * drop 'unsafe-inline' from script-src. Loaded in <head> before the other
 * renderer scripts; the listeners only register here, and the error handlers
 * themselves query the DOM at error time (long after the document has parsed),
 * so boot order is safe.
 */
window.__errors = [];
// Unhandled renderer errors surface as a system chat line — invisible
// failures are how the preview looked broken while only the list was stale.
window.addEventListener('error', (e) => {
  window.__errors.push(String(e.message || e.error));
  const log = document.querySelector('#chat-log');
  if (log) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = '[renderer error] ' + (e.message || e.error);
    log.appendChild(div);
  }
});
window.addEventListener('unhandledrejection', (e) => {
  window.__errors.push('unhandledrejection: ' + String(e.reason && e.reason.message || e.reason));
});
