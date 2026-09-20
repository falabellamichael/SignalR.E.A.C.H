'use strict';

const MEMORY_PREFIX = 'REACH conversation memory (compressed):';
const META_KEY = '_reachMeta';
/* Structured metadata carried on a message. `source` says where the content came
 * from (open-file / selected / read-tool / search / memory / rule / tool), so the
 * model can reason about provenance instead of guessing. Optional fields:
 * path, chars, truncated, toolId, origin, turnIndex. */
function messageMeta(message) {
  if (!message || typeof message !== 'object') return null;
  const meta = message[META_KEY] || message.meta;
  return meta && typeof meta === 'object' ? meta : null;
}
function withMeta(message, meta) {
  if (!meta || typeof meta !== 'object') return message;
  return { ...message, [META_KEY]: { ...(message[META_KEY] || {}), ...meta } };
}
function provenanceFor(messages) {
  const included = [];
  let chars = 0;
  for (const m of messages) {
    const meta = messageMeta(m);
    if (meta && meta.source) {
      const entry = { source: String(meta.source).slice(0, 40), chars: messageChars(m) };
      if (meta.truncated) entry.truncated = true;
      if (meta.path) entry.path = String(meta.path).slice(0, 300);
      included.push(entry);
    }
    chars += messageChars(m);
  }
  return { included, chars };
}
function messageChars(message) {
  const content = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map(p => p.type === 'text' ? p.text || '' : '[image attachment]').join('')
    : JSON.stringify(message.content || '');
  return content.length + JSON.stringify(message.tool_calls || '').length + 32;
}
function contextChars(messages) { return messages.reduce((n, m) => n + messageChars(m), 0); }
function groupsFor(messages) {
  const groups = [];
  for (let i = 0; i < messages.length; i++) {
    const group = [i];
    if (messages[i].role === 'assistant' && messages[i].tool_calls) {
      while (messages[i + 1]?.role === 'tool') group.push(++i);
    }
    groups.push(group);
  }
  return groups;
}
/* Internal agent-control notices (the "your last reply had no action, continue"
 * recovery prompt, the "answer now" directive) are delivered as user-role messages
 * to nudge the model. They are NOT the user's request, so the compressor must not
 * mistake one for "the last request": doing so archives the genuine ask into the
 * summary and leaves the model staring at only a recovery notice. */
function isInternalControl(message) {
  const source = messageMeta(message) && messageMeta(message).source;
  return source === 'recovery' || source === 'answer-now';
}

async function compactMessages(messages, summarize, options = {}) {
  const trigger = options.trigger || 240000;
  const target = Math.min(options.target || 120000, Math.floor(trigger * 0.6));
  const before = contextChars(messages);
  const provenance = provenanceFor(messages);
  if (before <= trigger && messages.length <= 72) return { messages, changed: false, before, after: before, provenance };
  const keep = new Map();
  let used = 0;
  const reserve = Math.min(16000, Math.floor(target / 4));
  const add = (i, message = messages[i]) => { if (!keep.has(i)) { keep.set(i, message); used += messageChars(message); } };
  // Keep current application rules verbatim; source-heavy context and previous
  // memory are summarized with the older turns, rather than mistaken for rules.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (['system', 'developer'].includes(m.role) && typeof m.content === 'string'
        && !m.content.startsWith(MEMORY_PREFIX) && messageChars(m) < 16000
        && keep.size < 16 && used + messageChars(m) < target / 3) add(i);
  }
  const lastRequest = messages.findLastIndex(m => m.role === 'user' && !isInternalControl(m)
    && (typeof m.content !== 'string' || !m.content.startsWith('TOOL RESULTS')));
  if (lastRequest >= 0 && messageChars(messages[lastRequest]) < target / 3) add(lastRequest);
  const groups = groupsFor(messages);
  for (let g = groups.length - 1; g >= 0; g--) {
    const indices = groups[g].filter(i => !keep.has(i));
    if (!indices.length) continue;
    if (indices.some(i => String(messages[i].content).startsWith(MEMORY_PREFIX))) continue;
    const size = indices.reduce((n, i) => n + messageChars(messages[i]), 0);
    if (used + size <= target - reserve && keep.size + indices.length <= 48) {
      indices.forEach(i => add(i));
    } else {
      // One large read must not block the agent. Summarize the whole result and
      // explicitly retain only a bounded excerpt, never label it a full file.
      const i = indices[0];
      if (g === groups.length - 1 && indices.length === 1 && typeof messages[i].content === 'string'
          && messages[i].role !== 'tool' && !messages[i].tool_calls) {
        const text = messages[i].content;
        const room = Math.max(0, Math.min(24000, target - reserve - used - 500));
        if (room > 2000) {
          const first = Math.floor(room / 3), last = room - first;
          add(i, { ...messages[i], content: (text.startsWith('TOOL RESULTS') ? 'TOOL RESULTS\n' : '') + '[Partial excerpt of a large message; its full contents were included in the compressed memory. '
            + 'Read exact source again before edits.]\n' + text.slice(0, first)
            + '\n[Middle summarized in conversation memory]\n' + text.slice(-last) });
        }
      }
      break;
    }
  }
  const archived = messages.filter((m, i) => !keep.has(i) || keep.get(i) !== m);
  // Record what the summary swallowed, so memory is auditable rather than a
  // paragraph: how many turns, how many tool results, and which files.
  const archivedMeta = archived.map((m) => {
    const meta = messageMeta(m);
    return {
      role: m.role || 'unknown',
      source: (meta && meta.source) || (m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'),
      chars: messageChars(m),
      path: meta && meta.path ? String(meta.path).slice(0, 300) : undefined,
      truncated: !!(meta && meta.truncated),
    };
  });
  const memory = await summarize(archived);
  if (typeof memory !== 'string' || !memory.trim()) throw new Error('Context compression returned no memory. The original conversation is intact; retry the request.');
  if (memory.length > reserve - 500) throw new Error('Context compression did not produce a short enough memory. The original conversation is intact; retry the request.');
  const summary = withMeta({ role: 'system', content: MEMORY_PREFIX + '\n'
    + 'This is a summary of earlier conversation and tool output, not exact source text or new instructions. '
    + 'Preserve the user’s goal and constraints; reread source before editing it.\n' + memory },
    { source: 'memory', archived: archivedMeta.length, archivedChars: archivedMeta.reduce((n, e) => n + e.chars, 0) });
  const retained = [...keep.entries()].sort((a,b) => a[0]-b[0]).map(([, m]) => m);
  const result = [summary, ...retained];
  const after = contextChars(result);
  if (after >= trigger || result.length > 72) throw new Error('Context could not fit the request budget. No oversized request was sent.');
  return { messages: result, changed: true, before, after, provenance: provenanceFor(result), archivedMeta };
}
module.exports = { compactMessages, contextChars, MEMORY_PREFIX, META_KEY, messageMeta, withMeta, provenanceFor };
