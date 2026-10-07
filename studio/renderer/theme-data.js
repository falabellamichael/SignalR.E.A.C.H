/* Theme catalog and accent tinting. Loaded as a classic script and as CJS. */
(function (factory) {
  const api = factory();
  const root = typeof globalThis !== 'undefined' ? globalThis : this;
  root.ReachThemes = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(function () {
  const DEFAULT_TINT = 24;
  const TINT_KEYS = ['panel', 'panel2', 'header', 'surface', 'card', 'hover', 'user-bg', 'selection', 'active-line', 'edit-bg', 'code-bg', 'subagent-bg', 'line'];

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = Number.parseInt(full, 16);
    if (!Number.isFinite(n) || full.length !== 6) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    if (!A || !B) return a;
    const k = clamp(t, 0, 1);
    return rgbToHex(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
  }

  function luminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function validHex(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value).toLowerCase() : '';
  }

  const darkChrome = { scrim: 'rgba(0,0,0,.65)', shadow: '#0008', 'diff-add': '#9fc490', 'diff-del': '#d1937c' };
  const lightChrome = { scrim: 'rgba(55,48,31,.30)', shadow: '#5c4b2524', 'diff-add': '#406327', 'diff-del': '#ac4637' };

  function theme(id, name, scheme, vars) {
    return { id, name, scheme, vars: { ...(scheme === 'light' ? lightChrome : darkChrome), ...vars } };
  }

  /* Dark and Light are the current Reach palettes. Tokyo Night, Storm, and Day
   * follow the published Tokyo Night swatches. The other five are separate palettes. */
  const themes = [
    theme('dark', 'Dark', 'dark', {
      bg: '#0a0a0a', panel: '#111111', panel2: '#161616', line: '#2c3328',
      gold: '#b6f04a', 'gold-dim': '#7eae42', text: '#e6e0cc', dim: '#8a8578',
      err: '#c96a4a', ok: '#7aa86a', header: '#0e0e0e', surface: '#060606', card: '#0d0d0d',
      'user-bg': '#141c10', 'user-line': '#3a5224', hover: '#1a2614', 'code-bg': '#1a1810',
      'code-text': '#e6c07b', 'edit-bg': '#0d0c08', 'subagent-bg': '#0a0a08', 'subagent-line': '#4a682c',
      muted: '#8a8578', 'success-line': '#2c4026', 'error-line': '#4a2c22',
      'button-text': '#0a0a0a', 'button-hover': '#c8f86a', selection: '#182412', 'active-line': '#10180c',
      'syntax-string': '#a8c187', 'syntax-number': '#d19a66', 'syntax-comment': '#948b76',
      'syntax-type': '#c678dd', 'syntax-property': '#e06c75',
    }),
    theme('light', 'Light', 'light', {
      bg: '#fdf6e3', panel: '#f6efdd', panel2: '#fffaf0', line: '#9b8e74',
      gold: '#946b12', 'gold-dim': '#8b7548', text: '#3e5055', dim: '#68736f',
      err: '#b54c37', ok: '#527037', header: '#fffdf7', surface: '#fffefa', card: '#fffdf7',
      'user-bg': '#f2ead2', 'user-line': '#9f8954', hover: '#eee5cb', 'code-bg': '#f0eadb',
      'code-text': '#866016', 'edit-bg': '#f7f2e5', 'subagent-bg': '#f9f4e8', 'subagent-line': '#9b7e3c',
      muted: '#73796f', 'success-line': '#748660', 'error-line': '#aa7966',
      'button-text': '#fffdf7', 'button-hover': '#7b580e', selection: '#e4d8b6', 'active-line': '#f7f0de',
      'syntax-string': '#607a17', 'syntax-number': '#b15b16', 'syntax-comment': '#73796f',
      'syntax-type': '#6c71c4', 'syntax-property': '#b44d59',
    }),
    theme('tokyo-night', 'Tokyo Night', 'dark', {
      bg: '#1a1b26', panel: '#16161e', panel2: '#24283b', line: '#414868',
      gold: '#7aa2f7', 'gold-dim': '#5d7ec4', text: '#c0caf5', dim: '#565f89',
      err: '#f7768e', ok: '#9ece6a', header: '#16161e', surface: '#13141f', card: '#1a1b26',
      'user-bg': '#1f2335', 'user-line': '#3b4261', hover: '#292e42', 'code-bg': '#16161e',
      'code-text': '#7dcfff', 'edit-bg': '#16161e', 'subagent-bg': '#13141f', 'subagent-line': '#3d59a1',
      muted: '#9aa5ce', 'success-line': '#2a3a32', 'error-line': '#4a2a36',
      'button-text': '#1a1b26', 'button-hover': '#9ab4f8', selection: '#283457', 'active-line': '#1f2335',
      'syntax-string': '#9ece6a', 'syntax-number': '#ff9e64', 'syntax-comment': '#565f89',
      'syntax-type': '#2ac3de', 'syntax-property': '#bb9af7',
    }),
    theme('tokyo-storm', 'Tokyo Storm', 'dark', {
      bg: '#24283b', panel: '#1f2335', panel2: '#292e42', line: '#414868',
      gold: '#7aa2f7', 'gold-dim': '#5d7ec4', text: '#c0caf5', dim: '#565f89',
      err: '#f7768e', ok: '#9ece6a', header: '#1f2335', surface: '#1a1b26', card: '#24283b',
      'user-bg': '#1f2335', 'user-line': '#3b4261', hover: '#343b58', 'code-bg': '#1f2335',
      'code-text': '#7dcfff', 'edit-bg': '#1a1b26', 'subagent-bg': '#1a1b26', 'subagent-line': '#3d59a1',
      muted: '#9aa5ce', 'success-line': '#2c3d36', 'error-line': '#4a303c',
      'button-text': '#1a1b26', 'button-hover': '#9ab4f8', selection: '#36467a', 'active-line': '#292e42',
      'syntax-string': '#9ece6a', 'syntax-number': '#ff9e64', 'syntax-comment': '#565f89',
      'syntax-type': '#2ac3de', 'syntax-property': '#bb9af7',
    }),
    theme('tokyo-day', 'Tokyo Day', 'light', {
      bg: '#e6e7ed', panel: '#dcdde4', panel2: '#f3f4f8', line: '#b8bac6',
      gold: '#2959aa', 'gold-dim': '#1d4b8f', text: '#343b58', dim: '#6c6e75',
      err: '#8c4351', ok: '#385f0d', header: '#f3f4f8', surface: '#f7f8fb', card: '#eef0f5',
      'user-bg': '#d5d7e2', 'user-line': '#8d90a3', hover: '#d4d6e1', 'code-bg': '#f3f4f8',
      'code-text': '#0f4b6e', 'edit-bg': '#f3f4f8', 'subagent-bg': '#f7f8fb', 'subagent-line': '#5a3e8e',
      muted: '#6c6e75', 'success-line': '#8aa36a', 'error-line': '#c48b96',
      'button-text': '#f4f5f8', 'button-hover': '#1d4b8f', selection: '#c9d4ea', 'active-line': '#f3f4f8',
      'syntax-string': '#385f0d', 'syntax-number': '#965027', 'syntax-comment': '#6c6e75',
      'syntax-type': '#006c86', 'syntax-property': '#5a3e8e',
    }),
    theme('nord', 'Nord', 'dark', {
      bg: '#2e3440', panel: '#3b4252', panel2: '#434c5e', line: '#4c566a',
      gold: '#88c0d0', 'gold-dim': '#6a9aab', text: '#eceff4', dim: '#aeb8c8',
      err: '#bf616a', ok: '#a3be8c', header: '#2b303b', surface: '#272c36', card: '#323845',
      'user-bg': '#3b4252', 'user-line': '#4c566a', hover: '#434c5e', 'code-bg': '#2b303b',
      'code-text': '#8fbcbb', 'edit-bg': '#2b303b', 'subagent-bg': '#272c36', 'subagent-line': '#81a1c1',
      muted: '#d8dee9', 'success-line': '#3d4d3c', 'error-line': '#5a3a40',
      'button-text': '#2e3440', 'button-hover': '#a6d4e0', selection: '#3f4c62', 'active-line': '#343b4a',
      'syntax-string': '#a3be8c', 'syntax-number': '#b48ead', 'syntax-comment': '#7b88a1',
      'syntax-type': '#81a1c1', 'syntax-property': '#ebcb8b',
    }),
    theme('catppuccin', 'Catppuccin', 'dark', {
      bg: '#1e1e2e', panel: '#181825', panel2: '#313244', line: '#45475a',
      gold: '#cba6f7', 'gold-dim': '#a684d4', text: '#cdd6f4', dim: '#a6adc8',
      err: '#f38ba8', ok: '#a6e3a1', header: '#11111b', surface: '#11111b', card: '#1e1e2e',
      'user-bg': '#313244', 'user-line': '#585b70', hover: '#313244', 'code-bg': '#181825',
      'code-text': '#89dceb', 'edit-bg': '#181825', 'subagent-bg': '#11111b', 'subagent-line': '#b4befe',
      muted: '#bac2de', 'success-line': '#2d3d34', 'error-line': '#4a3040',
      'button-text': '#1e1e2e', 'button-hover': '#dcc4fa', selection: '#45475a', 'active-line': '#24243a',
      'syntax-string': '#a6e3a1', 'syntax-number': '#fab387', 'syntax-comment': '#6c7086',
      'syntax-type': '#f9e2af', 'syntax-property': '#f38ba8',
    }),
    theme('rose-pine', 'Rosé Pine', 'dark', {
      bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', line: '#403d52',
      gold: '#ebbcba', 'gold-dim': '#c49a98', text: '#e0def4', dim: '#908caa',
      err: '#eb6f92', ok: '#9ccfd8', header: '#16141f', surface: '#1f1d2e', card: '#191724',
      'user-bg': '#26233a', 'user-line': '#524f67', hover: '#26233a', 'code-bg': '#1f1d2e',
      'code-text': '#c4a7e7', 'edit-bg': '#16141f', 'subagent-bg': '#16141f', 'subagent-line': '#c4a7e7',
      muted: '#908caa', 'success-line': '#2c3d42', 'error-line': '#4a3040',
      'button-text': '#191724', 'button-hover': '#f0d0ce', selection: '#403d52', 'active-line': '#211f30',
      'syntax-string': '#f6c177', 'syntax-number': '#eb6f92', 'syntax-comment': '#6e6a86',
      'syntax-type': '#c4a7e7', 'syntax-property': '#9ccfd8',
    }),
    theme('gruvbox', 'Gruvbox', 'dark', {
      bg: '#282828', panel: '#1d2021', panel2: '#3c3836', line: '#504945',
      gold: '#fe8019', 'gold-dim': '#d06513', text: '#ebdbb2', dim: '#a89984',
      err: '#fb4934', ok: '#b8bb26', header: '#1d2021', surface: '#1d2021', card: '#282828',
      'user-bg': '#3c3836', 'user-line': '#665c54', hover: '#3c3836', 'code-bg': '#1d2021',
      'code-text': '#fabd2f', 'edit-bg': '#1d2021', 'subagent-bg': '#1d2021', 'subagent-line': '#d79921',
      muted: '#bdae93', 'success-line': '#3c4018', 'error-line': '#5a2e28',
      'button-text': '#1d2021', 'button-hover': '#ff9a45', selection: '#504945', 'active-line': '#32302f',
      'syntax-string': '#b8bb26', 'syntax-number': '#d3869b', 'syntax-comment': '#928374',
      'syntax-type': '#fabd2f', 'syntax-property': '#83a598',
    }),
    theme('solarized', 'Solarized', 'dark', {
      bg: '#002b36', panel: '#073642', panel2: '#0a4050', line: '#586e75',
      gold: '#268bd2', 'gold-dim': '#1b6ca3', text: '#eee8d5', dim: '#93a1a1',
      err: '#dc322f', ok: '#859900', header: '#00212b', surface: '#00212b', card: '#073642',
      'user-bg': '#073642', 'user-line': '#586e75', hover: '#0a4050', 'code-bg': '#00212b',
      'code-text': '#2aa198', 'edit-bg': '#00212b', 'subagent-bg': '#00212b', 'subagent-line': '#6c71c4',
      muted: '#93a1a1', 'success-line': '#1d3a16', 'error-line': '#4a2218',
      'button-text': '#fdf6e3', 'button-hover': '#4aa3e0', selection: '#0a4a5c', 'active-line': '#073642',
      'syntax-string': '#2aa198', 'syntax-number': '#d33682', 'syntax-comment': '#657b83',
      'syntax-type': '#b58900', 'syntax-property': '#6c71c4',
    }),
  ];

  const byId = new Map(themes.map(item => [item.id, item]));

  function findTheme(id) {
    return byId.get(String(id || '')) || byId.get('dark');
  }

  function normalize(input, fallback) {
    const source = typeof input === 'string' ? { theme: input } : (input && typeof input === 'object' ? input : {});
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    const theme = findTheme(source.theme || base.theme);
    const tintRaw = source.tint != null ? source.tint : base.tint;
    const tint = Number.isFinite(Number(tintRaw)) ? clamp(Math.round(Number(tintRaw)), 0, 100) : DEFAULT_TINT;
    const accent = validHex(source.accent != null ? source.accent : base.accent);
    return { theme: theme.id, accent, tint };
  }

  function paint(input, fallback) {
    const choice = normalize(input, fallback);
    const theme = findTheme(choice.theme);
    const accent = choice.accent || theme.vars.gold;
    const custom = accent.toLowerCase() !== theme.vars.gold.toLowerCase();
    const vars = { ...theme.vars };
    const amount = (choice.tint / 100) * 0.48;
    if (custom) {
      vars.gold = accent;
      vars['gold-dim'] = theme.scheme === 'dark' ? mix(accent, '#000000', 0.34) : mix(accent, '#1a1408', 0.26);
      vars['button-hover'] = theme.scheme === 'dark' ? mix(accent, '#ffffff', 0.2) : mix(accent, '#000000', 0.16);
      vars['button-text'] = luminance(accent) > 0.45 ? '#0a0a0a' : '#fffdf7';
      vars['user-line'] = mix(theme.vars['user-line'], accent, 0.62);
      vars['subagent-line'] = mix(theme.vars['subagent-line'], accent, 0.55);
    }
    if (amount > 0) {
      for (const key of TINT_KEYS) vars[key] = mix(theme.vars[key], accent, key === 'line' ? amount * 0.7 : amount);
    }
    return {
      theme: theme.id,
      name: theme.name,
      scheme: theme.scheme,
      accent: custom ? accent.toLowerCase() : '',
      tint: choice.tint,
      bg: vars.bg,
      vars,
    };
  }

  return { themes, DEFAULT_TINT, findTheme, normalize, paint, validHex, hexToRgb, rgbToHex, mix };
});
