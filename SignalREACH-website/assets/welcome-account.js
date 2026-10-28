/* Cached account hints only affect navigation; account pages validate access. */
(() => {
  const tile = document.getElementById('welcome-account');
  if (!tile) return;
  function update() {
    let signedIn = false, known = false;
    try {
      const session = JSON.parse(sessionStorage.getItem('signalreach.account.session') || 'null');
      signedIn = typeof session?.accessToken === 'string' && session.accessToken.trim().length > 0;
    } catch (_) { /* Invalid or unavailable cache is treated as signed out. */ }
    try {
      known = localStorage.getItem('signalreach.account.known') === '1';
      if (signedIn) localStorage.setItem('signalreach.account.known', '1');
    } catch (_) { /* No persistent preference when storage is unavailable. */ }
    document.getElementById('welcome-account-title').textContent = signedIn ? 'Your account' : known ? 'Sign In' : 'Sign Up Today';
    tile.href = signedIn ? 'profile.html' : 'login.html?subscribe=1';
    // Keep the plan description visible without presenting a cached hint as entitlement.
    document.getElementById('welcome-signin').hidden = signedIn;
    document.getElementById('welcome-profile').hidden = !signedIn;
  }
  update();
  window.addEventListener('pageshow', update);
  window.addEventListener('storage', update);
})();
