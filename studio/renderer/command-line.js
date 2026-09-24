'use strict';

/* Parse a command into argv for direct process spawning. Quotes group text but
 * never invoke a shell, so variables and control operators stay literal. */
function parseProjectCommand(line) {
  if (typeof line !== 'string') throw new TypeError('Command must be text.');
  const args = [];
  let value = '';
  let started = false;
  let quote = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && (next === '"' || next === '\\')) {
        value += next;
        i++;
      } else value += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) { args.push(value); value = ''; started = false; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === '\\' && next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
      value += next;
      started = true;
      i++;
      continue;
    }
    value += ch;
    started = true;
  }
  if (quote) throw new Error(`Unclosed ${quote === '"' ? 'double' : 'single'} quote in command.`);
  if (started) args.push(value);
  return args;
}

globalThis.ReachCommandLine = Object.freeze({ parse: parseProjectCommand });
if (typeof module !== 'undefined' && module.exports) module.exports = { parseProjectCommand };
