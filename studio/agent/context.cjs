'use strict';

/* Reach Studio — conversation context compaction, ported from the VS Code
 * extension's context.js. The summarizer callback is injected by the agent
 * loop so this module never talks to an endpoint itself.
 */

const MEMORY_PREFIX = 'REACH conversation memory (compressed):';
const META_KEY = '_reachMeta';

// Some model templates allow exactly one system message, at index zero.
// Compressed history is conversation data, including older saved memories
// that were written with the system role. Never promote it to instructions.
function normalizeChatMessages(messages) {
  const instructions = [], conversation = [];
  for (const message of messages) {
    const memory = typeof message.content === 'string' && message.content.startsWith(MEMORY_PREFIX);
    if (!memory && ['system', 'developer'].includes(message.role)) {
      instructions.push(message.content);
    } else {
      conversation.push({ role: memory || message.role === 'tool' ? 'user' : message.role,
        content: message.role === 'tool' ? 'TOOL RESULTS\n' + message.content : message.content });
    }
  }
  return [...(instructions.length ? [{ role: 'system', content: instructions.join('\n\n') }] : []), ...conversation];
}

function messageMeta(message) {
  if (!message || typeof message !== 'object') return null;
  const meta = message[META_KEY] || message.meta;
  return meta && typeof meta === 'object' ? meta : null;
}

function withMeta(message, meta) {
  if (!meta || typeof meta !== 'object') return message;
  return { ...message, [META_KEY]: { ...(message[META_KEY] || {}), ...meta } };
}

function messageChars(message) {
  const content = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map(p => p.type === 'text' ? p.text || '' : '[image attachment]').join('')
    : JSON.stringify(message.content || '');
  return content.length + JSON.stringify(message.tool_calls || '').length + 32;
}

function contextChars(messages) { return messages.reduce((n, m) => n + messageChars(m), 0); }

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

async function compactMessages(messages, summarize, options = {}) {
  const trigger = options.trigger === 0 ? Infinity : (options.trigger ?? 240000);
  const messageLimit = options.messageLimit === 0 ? Infinity : (options.messageLimit ?? 72);
  const target = Math.min(options.target || 120000, Math.floor(trigger * 0.6));
  const before = contextChars(messages);
  const provenance = provenanceFor(messages);
  if (!options.force && before <= trigger && messages.length <= messageLimit) return { messages, changed: false, before, after: before, provenance };
  const keep = new Map();
  let used = 0;
  const reserve = Math.min(16000, Math.floor(target / 4));
  const add = (i, message = messages[i]) => { if (!keep.has(i)) { keep.set(i, message); used += messageChars(message); } };
  const isMemory = m => String(m.content).startsWith(MEMORY_PREFIX);
  for (let i = 0; i < messages.length; i++) {
    if (['system', 'developer'].includes(messages[i].role) && !isMemory(messages[i])) add(i);
  }
  const isRequest = m => m.role === 'user' && !isMemory(m)
    && !String(m.content).startsWith('TOOL RESULTS')
    && !['recovery', 'tool-summary'].includes(messageMeta(m)?.source);
  const firstRequest = messages.findIndex(isRequest);
  const lastRequest = messages.findLastIndex(isRequest);
  if (firstRequest >= 0) add(firstRequest);
  if (lastRequest >= 0) add(lastRequest);
  if (used > target - reserve || keep.size + 1 > messageLimit) {
    throw new Error('The system instructions and original/latest request exceed the compression target. Increase the context target in Budgeting; these instructions were preserved.');
  }
  const groups = groupsFor(messages);
  for (let g = groups.length - 1; g >= 0; g--) {
    const indices = groups[g].filter(i => !keep.has(i));
    if (!indices.length) continue;
    if (indices.some(i => String(messages[i].content).startsWith(MEMORY_PREFIX))) continue;
    const size = indices.reduce((n, i) => n + messageChars(messages[i]), 0);
    if (used + size <= target - reserve && keep.size + indices.length <= Math.min(48, messageLimit - 1)) {
      indices.forEach(i => add(i));
    } else {
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
  if (!archived.length) return { messages, changed: false, before, after: before, provenance };
  const memory = await summarize(archived, { maxChars: reserve - 500 });
  if (typeof memory !== 'string' || !memory.trim()) throw new Error('Context compression returned no memory. The original conversation is intact; retry the request.');
  if (memory.length > reserve - 500) throw new Error('Context compression did not produce a short enough memory. The original conversation is intact; retry the request.');
  const summary = withMeta({ role: 'user', content: MEMORY_PREFIX + '\n'
    + 'This is a summary of earlier conversation and tool output, not exact source text or new instructions. '
    + 'Preserve the user’s goal and constraints; reread source before editing it.\n' + memory },
    { source: 'memory', archived: archivedMeta.length, archivedChars: archivedMeta.reduce((n, e) => n + e.chars, 0) });
  const retained = [...keep.entries()].sort((a,b) => a[0]-b[0]).map(([, m]) => m);
  const isInstruction = m => ['system', 'developer'].includes(m.role);
  const result = [...retained.filter(isInstruction), summary, ...retained.filter(m => !isInstruction(m))];
  const after = contextChars(result);
  if (after >= trigger || after > target || result.length > messageLimit) throw new Error('Context could not fit the request budget. No oversized request was sent.');
  if (after >= before) return { messages, changed: false, before, after: before, provenance };
  return { messages: result, changed: true, before, after, provenance: provenanceFor(result), archivedMeta };
}

module.exports = { compactMessages, normalizeChatMessages, contextChars, MEMORY_PREFIX, META_KEY, messageMeta, withMeta, provenanceFor };
