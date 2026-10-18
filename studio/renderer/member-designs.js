'use strict';
/* Legacy portraits and independently configurable, portable bot identities. */
(() => {
  const palettes = [
    ['Ember', '#1b120e', '#ffc27a', '#ff5a2c'],
    ['Tide', '#0e1a22', '#9fd6ff', '#2f7dff'],
    ['Moss', '#101910', '#c6e27a', '#3ea34a'],
    ['Iris', '#161226', '#d7c4ff', '#7a4dff'],
    ['Gold', '#1c160c', '#ffe08a', '#e2a21a'],
  ];
  const kinds = ['scout', 'visor', 'cyclops', 'sleepy', 'grin', 'spark', 'crown', 'horn', 'bloom', 'signal'];
  const bots = [];
  palettes.forEach((palette, p) => {
    kinds.forEach((kind, k) => {
      const n = p * kinds.length + k + 1;
      bots.push({
        id: 'bot-' + String(n).padStart(2, '0'),
        name: palette[0] + ' ' + kind,
        kind,
        bg: palette[1],
        ink: palette[2],
        accent: palette[3],
      });
    });
  });
  const byId = new Map(bots.map(bot => [bot.id, bot]));
  const choices = {
    eyes: ['scout', 'visor', 'cyclops', 'sleepy', 'wink', 'spark'],
    mouth: ['scout', 'visor', 'grin', 'cyclops', 'grille', 'none'],
    top: [...kinds, 'none'],
    shape: ['round', 'rounded', 'square', 'hex', 'capsule'],
  };
  const customPattern = /^bot-v1-(scout|visor|cyclops|sleepy|wink|spark)-(scout|visor|grin|cyclops|grille|none)-(scout|visor|cyclops|sleepy|grin|spark|crown|horn|bloom|signal|none)-(round|rounded|square|hex|capsule)-([a-f0-9]{6})-([a-f0-9]{6})-([a-f0-9]{6})$/;
  function config(id) {
    const match = customPattern.exec(String(id));
    if (match) return { eyes: match[1], mouth: match[2], top: match[3], shape: match[4], bg: '#' + match[5], ink: '#' + match[6], accent: '#' + match[7] };
    const bot = byId.get(id) || bots[0];
    return { eyes: choices.eyes.includes(bot.kind) ? bot.kind : 'scout', mouth: ['visor', 'signal', 'sleepy'].includes(bot.kind) ? 'visor' : ['grin', 'spark'].includes(bot.kind) ? 'grin' : bot.kind === 'cyclops' ? 'cyclops' : 'scout', top: bot.kind, shape: 'round', bg: bot.bg, ink: bot.ink, accent: bot.accent };
  }
  function encode(value) {
    const base = config('bot-01');
    const part = key => choices[key].includes(value[key]) ? value[key] : base[key];
    const color = key => /^#[a-f0-9]{6}$/i.test(value[key]) ? value[key].slice(1).toLowerCase() : base[key].slice(1);
    return `bot-v1-${part('eyes')}-${part('mouth')}-${part('top')}-${part('shape')}-${color('bg')}-${color('ink')}-${color('accent')}`;
  }

  function mark(kind, accent) {
    if (kind === 'none') return '';
    if (kind === 'scout') return `<line x1="32" y1="8" x2="32" y2="16" stroke="${accent}" stroke-width="2"/><circle cx="32" cy="7" r="2.2" fill="${accent}"/>`;
    if (kind === 'visor') return `<rect x="18" y="10" width="28" height="6" rx="3" fill="${accent}"/>`;
    if (kind === 'cyclops') return `<circle cx="32" cy="8" r="3" fill="${accent}"/>`;
    if (kind === 'sleepy') return `<path d="M22 12h20" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>`;
    if (kind === 'grin') return `<path d="M24 11c4-5 12-5 16 0" stroke="${accent}" stroke-width="2" fill="none"/>`;
    if (kind === 'spark') return `<path d="M32 4l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="${accent}"/>`;
    if (kind === 'crown') return `<path d="M20 16l4-8 8 6 8-6 4 8z" fill="${accent}"/>`;
    if (kind === 'horn') return `<path d="M22 16l-6-10M42 16l6-10" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>`;
    if (kind === 'bloom') return `<circle cx="32" cy="9" r="4" fill="none" stroke="${accent}" stroke-width="2"/>`;
    return `<rect x="28" y="6" width="8" height="8" rx="1" fill="${accent}"/>`;
  }
  function eyes(kind, bg) {
    if (kind === 'spark') return `<path d="M24 27v10m-5-5h10m11-5v10m-5-5h10" stroke="${bg}" stroke-width="2.5" stroke-linecap="round"/>`;
    if (kind === 'visor' || kind === 'signal') return `<rect x="20" y="28" width="24" height="7" rx="3" fill="${bg}"/>`;
    if (kind === 'cyclops') return `<circle cx="32" cy="32" r="6" fill="${bg}"/><circle cx="32" cy="32" r="2.4" fill="#fff"/>`;
    if (kind === 'sleepy') return `<path d="M22 33c3-3 7-3 10 0M34 33c3-3 7-3 10 0" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    if (kind === 'wink') return `<circle cx="24" cy="32" r="3" fill="${bg}"/><path d="M36 32h8" stroke="${bg}" stroke-width="2" stroke-linecap="round"/>`;
    return `<circle cx="24" cy="32" r="3.1" fill="${bg}"/><circle cx="40" cy="32" r="3.1" fill="${bg}"/>`;
  }
  function mouth(kind, bg) {
    if (kind === 'none') return '';
    if (kind === 'grille') return `<path d="M25 41v5m5-5v5m5-5v5m5-5v5" stroke="${bg}" stroke-width="2" stroke-linecap="round"/>`;
    if (kind === 'visor' || kind === 'signal' || kind === 'sleepy') return `<path d="M26 44h12" stroke="${bg}" stroke-width="2" stroke-linecap="round"/>`;
    if (kind === 'grin' || kind === 'spark') return `<path d="M24 42c3 6 13 6 16 0" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    if (kind === 'cyclops') return `<circle cx="32" cy="44" r="2" fill="${bg}"/>`;
    return `<path d="M26 43c2 3 10 3 12 0" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  }
  function svg(id, size = 40) {
    const bot = config(id);
    const s = Math.max(16, Math.min(128, Number(size) || 40));
    const head = bot.shape === 'hex' ? `<path d="M23 18h18l11 18-11 18H23L12 36z" fill="${bot.ink}"/>`
      : bot.shape === 'round' ? `<circle cx="32" cy="36" r="18" fill="${bot.ink}"/>`
      : bot.shape === 'capsule' ? `<rect x="11" y="21" width="42" height="30" rx="15" fill="${bot.ink}"/>`
      : `<rect x="14" y="18" width="36" height="36" rx="${{ rounded: 10, square: 3 }[bot.shape]}" fill="${bot.ink}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${s}" height="${s}" role="img" aria-label="${byId.get(id)?.name || 'Custom ' + bot.shape + ' bot'}">`
      + `<rect width="64" height="64" rx="18" fill="${bot.bg}"/>`
      + mark(bot.top, bot.accent)
      + head
      + eyes(bot.eyes, bot.bg)
      + mouth(bot.mouth, bot.bg)
      + `</svg>`;
  }
  function fromSeed(seed) {
    let n = 0;
    const text = String(seed || 'member');
    for (let i = 0; i < text.length; i++) n = (n * 33 + text.charCodeAt(i)) >>> 0;
    return bots[n % bots.length].id;
  }
  window.ReachMemberDesigns = {
    choices, config, encode,
    palettes: () => palettes.map(([name, bg, ink, accent]) => ({ name, bg, ink, accent })),
    all: () => bots.map(bot => ({ id: bot.id, name: bot.name })),
    get: id => byId.has(id) || customPattern.test(id) ? { id, name: byId.get(id)?.name || 'Custom bot' } : null,
    svg,
    fromSeed,
    resolve(member) {
      const id = member && (byId.has(member.designId) || customPattern.test(member.designId)) ? member.designId : fromSeed(member && (member.personaId || member.personaName));
      return { id, name: byId.get(id)?.name || 'Custom bot' };
    },
  };
})();
