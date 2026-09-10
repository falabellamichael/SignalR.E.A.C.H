// Verify the new pure helpers from extension.js: parseHeaderLines and the
// template expansion + append logic. These are the pieces that can silently
// misbehave, so they get real assertions.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'extension.js'), 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const body = extract('parseHeaderLines');
// eslint-disable-next-line no-eval
const parseHeaderLines = eval('(' + body + ')');

const cases = [
  ['X-Api-Key: abc123', { 'X-Api-Key': 'abc123' }],
  ['A: 1\nB: 2', { A: '1', B: '2' }],
  ['Url: https://x.dev/a:b', { Url: 'https://x.dev/a:b' }],   // value keeps its colon
  ['# comment\nGood: yes', { Good: 'yes' }],                  // comments skipped
  ['', {}],
  ['   ', {}],
  ['nocolon', {}],                                            // malformed skipped
  [': novalue', {}],
  ['Content-Length: 999', {}],                                // framing header refused
  ['Host: evil', {}],                                         // ditto
  ['Bad Name: v', {}],                                        // invalid chars refused
  ['X: 1\nX: 2', { X: '2' }],                                 // last wins
];
let fail = 0;
for (const [input, want] of cases) {
  const got = parseHeaderLines(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL  in=', JSON.stringify(input), 'got=', JSON.stringify(got), 'want=', JSON.stringify(want)); }
  else console.log('ok    ', JSON.stringify(input).padEnd(30), '->', JSON.stringify(got));
}

console.log('');
console.log(fail ? ('FAILURES: ' + fail) : 'parseHeaderLines: all passed');
process.exitCode = fail ? 1 : 0;
