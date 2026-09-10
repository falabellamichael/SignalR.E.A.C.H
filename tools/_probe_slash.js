// Probe the slash-command table + filter behaviour of chat.js.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'media', 'chat.js'), 'utf8');

const marker = 'const SLASH_COMMANDS = ';
const tblStart = src.indexOf(marker) + marker.length;
const tblEnd = src.indexOf('\n  ];', tblStart);
const literal = src.slice(tblStart, tblEnd + 4).replace(/;$/, '');
const normalized = literal.replace(/\n  \]/g, ']');
const table = eval(normalized);

console.log('commands defined:', table.length);
console.log('');

function filter(word) {
  const q = String(word).toLowerCase();
  let items = table.filter(function (c) {
    return c.name.slice(1).toLowerCase().startsWith(q) || c.desc.toLowerCase().includes(q);
  });
  if (!items.length && !q) items = table.slice();
  return items;
}

[['', 'bare slash -> all'], ['re', 'prefix'], ['rev', 'prefix'],
['ex', 'prefix'], ['commit', 'full'], ['bug', 'desc match'], ['zzz', 'no match']]
  .forEach(function (c) {
    const names = filter(c[0]).map(function (x) { return x.name; }).join(' ');
    console.log(('  /' + c[0]).padEnd(11), '->', (names || '(none)').padEnd(46), '|', c[1]);
  });

let fail = 0;
function assert(cond, msg) { if (!cond) { console.log('FAIL:', msg); fail++; } }
assert(filter('').length === table.length, 'bare slash lists everything');
assert(filter('re').some(function (c) { return c.name === '/review'; }), 're -> /review');
assert(filter('re').some(function (c) { return c.name === '/read'; }), 're -> /read');
assert(filter('zzz').length === 0, 'no match -> empty list');
assert(table.find(function (c) { return c.name === '/commit'; }).send === true, '/commit sends at once');
assert(!table.find(function (c) { return c.name === '/review'; }).send, '/review fills the composer');
assert(table.every(function (c) { return c.name.charAt(0) === '/'; }), 'all names start with /');
assert(table.every(function (c) { return c.desc && c.prompt; }), 'every command has desc + prompt');
console.log('');
console.log(fail ? ('FAILURES: ' + fail) : 'all assertions passed');
process.exitCode = fail ? 1 : 0;
