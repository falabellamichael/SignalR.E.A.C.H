// Exercise codegptClickSend's injected FONDER logic against a fake DOM that
// mirrors the live CodeGPT page (icon-only send button whose innerText is
// exactly "Send", plus decoy buttons).
const fs = require('node:fs');
const src = fs.readFileSync('copilot/tray/main.js', 'utf8');

// Pull the FINDER template out of the source and evaluate it.
const start = src.indexOf('const FINDER = `(() => {');
const end = src.indexOf('})()`;', start) + 5;
const tpl = src.slice(start + 'const FINDER = `'.length, end - 1);

// Minimal DOM shim.
function mkBtn({ text = '', aria = '', title = '', disabled = false,
  w = 24, h = 24, x = 100, y = 200 } = {}) {
  return {
    innerText: text, title, disabled,
    offsetWidth: w, offsetHeight: h,
    getAttribute: (k) => (k === 'aria-label' ? aria : ''),
    getBoundingClientRect: () => ({ x, y, width: w, height: h }),
  };
}

const scenarios = {
  'icon-only, exact Send text': [
    mkBtn({ text: '', aria: '' }),              // decoy
    mkBtn({ text: 'Send', x: 500, y: 640 }),    // the real one
  ],
  'aria-label send': [
    mkBtn({ text: '', aria: 'Send message', x: 400, y: 600 }),
  ],
  'title submit': [
    mkBtn({ text: '', title: 'Submit', x: 300, y: 500 }),
  ],
  'no send at all': [
    mkBtn({ text: 'Attach' }), mkBtn({ text: 'Settings' }),
  ],
};
// The finder JSON.stringifies CODEGPT_COMPOSER_SELECTOR; provide it.
const CODEGPT_COMPOSER_SELECTOR = 'textarea.mentions';
global.document = {
  querySelectorAll: (sel) => {
    if (sel.includes('button')) return global.__btns || [];
    return [];
  },
  querySelector: () => null,
};

for (const [name, btns] of Object.entries(scenarios)) {
  global.__btns = btns;
  const js = tpl.replace(/\$\{JSON\.stringify\(CODEGPT_COMPOSER_SELECTOR\)\}/g,
    JSON.stringify(CODEGPT_COMPOSER_SELECTOR));
  const out = eval(js);
  console.log(name.padEnd(28), '->', JSON.stringify(out));
}
