'use strict';

/* Reach Studio — DeepSeek DSML tool-call dialect.
 *
 * Some OpenAI-compatible endpoints stream the model's native tool markup as
 * plain content when no OpenAI `tools` array is advertised (this app's prompt
 * contract asks for JSON actions instead). Captured byte-exact from
 * api.deepseek.com (`deepseek-flash`) on 2026-09-19 — the token is
 * '<' + U+FF5C U+FF5C + 'DSML' + U+FF5C U+FF5C, e.g.:
 *
 *   I'll read these files. Since they're independent, I'll batch the calls.
 *
 *   <T calls>
 *   <T invoke name="read">
 *   <T parameter name="path" string="true">tests/x.py</T parameter>
 *   <T parameter name="startLine" string="false">250</T parameter>
 *   </T invoke>
 *   </T calls>
 *
 * The parser turns every invoke into a {name, arguments} action validated
 * against the tool registry, tolerates ASCII pipes, missing closing tags and
 * the `parameter name="arguments":{json}` variant, and returns the text with
 * the whole markup span removed so cards show prose only. */

const { allowedNames } = require('./tool-registry.cjs');

// Any DSML tag: <T invoke name="x"> / </T parameter> / <T calls>
const TAG = /<(\/)?[|\uFF5C]{1,2}\s*DSML\s*[|\uFF5C]{1,2}\s*(\/?)\s*([A-Za-z_]+)([^>]*)>/g;
const MAX_ACTIONS = 8;

function attr(attrs, name) {
  const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))').exec(attrs);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
}

function coerce(value, stringFlag) {
  const v = String(value).trim();
  if (stringFlag === 'false') {
    if (v === 'true') return true;
    if (v === 'false') return false;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/* The arguments value may arrive between the parameter tags or inside the
 * opening tag itself; find the first balanced {...} of a candidate string. */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const obj = JSON.parse(text.slice(start, i + 1));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
      } catch { return null; }
    }
  }
  return null;
}

function parseDsmlActions(text) {
  const raw = String(text || '');
  TAG.lastIndex = 0;
  const tags = [];
  let m;
  while ((m = TAG.exec(raw))) {
    tags.push({ start: m.index, end: m.index + m[0].length, close: m[1] === '/' || m[2] === '/', kind: m[3].toLowerCase(), attrs: m[4] || '' });
  }
  if (!tags.length) return { detected: false, actions: [], display: raw, error: null };
  const found = [];
  let current = null;   // open invoke
  let pending = null;   // open parameter { key, stringFlag, valueStart, tail }
  const finishParam = endIdx => {
    if (!pending || !current) { pending = null; return; }
    const value = raw.slice(pending.valueStart, endIdx);
    if (pending.key === 'arguments') {
      const obj = firstJsonObject((pending.tail || '') + ' ' + value.replace(/^\s*:/, ''));
      if (obj) Object.assign(current.arguments, obj);
      else if (value.trim()) current.arguments.arguments = value.trim();
    } else {
      current.arguments[pending.key] = coerce(value, pending.stringFlag);
    }
    pending = null;
  };
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.kind === 'invoke') {
      finishParam(tag.start);
      if (tag.close) { current = null; continue; }
      const name = attr(tag.attrs, 'name');
      current = name ? { name, arguments: {} } : null;
      if (current) found.push(current);
    } else if (tag.kind === 'parameter') {
      finishParam(tag.start);
      if (tag.close) continue;
      const key = attr(tag.attrs, 'name');
      const tail = key === 'arguments' && tag.attrs.includes('{')
        ? tag.attrs.slice(tag.attrs.indexOf('{'))
        : '';
      if (current && key) pending = { key, stringFlag: attr(tag.attrs, 'string'), valueStart: tag.end, tail };
    }
  }
  finishParam(raw.length);
  const names = allowedNames();
  const actions = [];
  let error = null;
  for (const a of found) {
    if (!names.includes(a.name)) { error = error || `Unknown tool name in DSML markup: ${a.name}`; continue; }
    if (Object.prototype.hasOwnProperty.call(a.arguments, 'action')) { error = error || 'DSML arguments must not contain the legacy action field.'; continue; }
    actions.push(a);
  }
  if (found.length > MAX_ACTIONS) error = error || `At most ${MAX_ACTIONS} actions are allowed per response.`;
  const display = (raw.slice(0, tags[0].start) + raw.slice(tags[tags.length - 1].end)).trim();
  return { detected: true, actions: actions.slice(0, MAX_ACTIONS), display, error };
}

module.exports = { parseDsmlActions };
