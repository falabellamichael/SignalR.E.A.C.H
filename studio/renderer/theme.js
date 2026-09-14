/* Apply the saved preference before the first paint. */
(() => {
  function apply(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
    const light = theme === 'light';
    const button = document.querySelector('#theme-toggle');
    if (button) {
      button.setAttribute('aria-checked', String(light));
      button.title = light ? 'Switch to dark theme' : 'Switch to warm light theme';
      button.querySelector('.theme-icon').textContent = light ? '☀' : '☾';
      button.querySelector('.theme-label').textContent = light ? 'Light' : 'Dark';
    }
    document.dispatchEvent(new Event('reach-theme-change'));
  }
  apply(window.reach.initialTheme);
  document.addEventListener('DOMContentLoaded', () => {
    apply(document.documentElement.dataset.theme);
    const button = document.querySelector('#theme-toggle');
    button.onclick = async () => {
      button.disabled = true;
      try {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        apply(await window.reach.setTheme(next));
      } catch (error) { window.ReachDialogs.notice('Could not save theme: ' + error.message); }
      finally { button.disabled = false; }
    };
  });
})();
