'use strict';
/* Fifty original bot portraits for team members. Each is a small flat character
 * the user picks in the team builder; the Singular panel shows the choice. */
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

  function mark(kind, accent) {
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
    if (kind === 'visor' || kind === 'signal') return `<rect x="20" y="28" width="24" height="7" rx="3" fill="${bg}"/>`;
    if (kind === 'cyclops') return `<circle cx="32" cy="32" r="6" fill="${bg}"/><circle cx="32" cy="32" r="2.4" fill="#fff"/>`;
    if (kind === 'sleepy') return `<path d="M22 33c3-3 7-3 10 0M34 33c3-3 7-3 10 0" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    if (kind === 'wink') return `<circle cx="24" cy="32" r="3" fill="${bg}"/><path d="M36 32h8" stroke="${bg}" stroke-width="2" stroke-linecap="round"/>`;
    return `<circle cx="24" cy="32" r="3.1" fill="${bg}"/><circle cx="40" cy="32" r="3.1" fill="${bg}"/>`;
  }
  function mouth(kind, bg) {
    if (kind === 'visor' || kind === 'signal' || kind === 'sleepy') return `<path d="M26 44h12" stroke="${bg}" stroke-width="2" stroke-linecap="round"/>`;
    if (kind === 'grin' || kind === 'spark') return `<path d="M24 42c3 6 13 6 16 0" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    if (kind === 'cyclops') return `<circle cx="32" cy="44" r="2" fill="${bg}"/>`;
    return `<path d="M26 43c2 3 10 3 12 0" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  }
  function svg(id, size = 40) {
    const bot = byId.get(id) || bots[0];
    const s = Math.max(16, Math.min(128, Number(size) || 40));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${s}" height="${s}" role="img" aria-label="${bot.name}">`
      + `<rect width="64" height="64" rx="18" fill="${bot.bg}"/>`
      + mark(bot.kind, bot.accent)
      + `<circle cx="32" cy="36" r="18" fill="${bot.ink}"/>`
      + eyes(bot.kind, bot.bg)
      + mouth(bot.kind, bot.bg)
      + `</svg>`;
  }
  function fromSeed(seed) {
    let n = 0;
    const text = String(seed || 'member');
    for (let i = 0; i < text.length; i++) n = (n * 33 + text.charCodeAt(i)) >>> 0;
    return bots[n % bots.length].id;
  }
  window.ReachMemberDesigns = {
    all: () => bots.map(bot => ({ id: bot.id, name: bot.name })),
    get: id => byId.has(id) ? { id, name: byId.get(id).name } : null,
    svg,
    fromSeed,
    resolve(member) {
      const id = member && byId.has(member.designId) ? member.designId : fromSeed(member && (member.personaId || member.personaName));
      return { id, name: byId.get(id).name };
    },
  };
})();
