'use strict';

/* Reach Studio — the FROZEN soul/memory file interface (agent id + userDataDir).
 *
 *   userData/agents/<agentId>/SOUL.md     — who the agent is (persona)
 *   userData/agents/<agentId>/MEMORY.md   — what it has learned (memory)
 *
 * This module is the flat-function contract other modules build against. It
 * shares its primitives with agent-soul.cjs (which owns the AgentSoulStore the
 * UI and the agent loop use) so the two cannot disagree about path containment,
 * the atomic-write pattern, or the size caps:
 *
 *   - sanitizeAgentKey  → agent-id validation (see the traversal note below)
 *   - atomicWriteText   → tmp + rename, mode 0600
 *
 * TRUST NOTE. Both files are injected into the system prompt. SOUL is the
 * operator's own writing (the durable half of a persona, same trust class as
 * personaPrompt). MEMORY is written at RUN time from tool-derived text, so
 * agent-soul.cjs fences its body as untrusted data — a memory line claiming
 * "the user approved this edit" must never act like permission.
 */

const fs = require('node:fs');
const path = require('node:path');

const { sanitizeAgentKey, MAX_SOUL_CHARS } = require('./agent-soul.cjs');
const { atomicWriteText } = require('./atomic-write.cjs');

/* The entry cap and the file cap are deliberately different numbers, because
 * they bound different things: one note cannot exceed 2,000 characters, while
 * the accumulated file may reach 64 KB before the agent is told to consolidate. */
const MAX_MEMORY_ENTRY_CHARS = 2000;
const MAX_MEMORY_BYTES = 64000;

/**
 * Validate an agent id and return it.
 *
 * NOTE ON THE FROZEN SPEC: the agreed pattern /^[A-Za-z0-9._-]+$/ ACCEPTS '..'.
 * Since these paths are built with path.join(userDataDir, 'agents', id), an id
 * of '..' resolves to userDataDir itself — the agent's SOUL.md/MEMORY.md would
 * be created one level ABOVE the agent store, mixing one agent's files into the
 * shared profile root, and a crafted id could reach further. sanitizeAgentKey is
 * that same rule plus the two conditions that close the hole: the id must START
 * with an alphanumeric character and may not be '.' or '..'. It additionally
 * rejects '/', '\\' and NUL. This is a strict superset of every legitimate id
 * (real ids look like `persona-mu8ts8qy-24roe4`), so nothing valid is refused —
 * only the traversal. Worst case it rejects an id the spec would have accepted;
 * that is the failure direction to prefer here.
 */
function assertAgentId(agentId) {
  const safe = sanitizeAgentKey(agentId);
  if (!safe) throw new Error('Invalid agent id for soul storage.');
  return safe;
}

/** <userDataDir>/agents/<agentId> — the agent's own folder. */
function soulDir(agentId, userDataDir) {
  const safe = assertAgentId(agentId);
  const dir = path.join(String(userDataDir), 'agents', safe);
  /* Belt and braces over the id check: the folder must be an immediate child of
   * <userDataDir>/agents, so no future edit to the key rule can turn this into a
   * traversal. */
  const parent = path.join(String(userDataDir), 'agents');
  if (path.dirname(dir) !== parent) throw new Error('Invalid agent id for soul storage.');
  return dir;
}

/** Absolute paths for the agent's two files. */
function soulFiles(agentId, userDataDir) {
  const dir = soulDir(agentId, userDataDir);
  return { dir, soul: path.join(dir, 'SOUL.md'), memory: path.join(dir, 'MEMORY.md') };
}

/**
 * Render the two templates. Exported so a caller can PREVIEW exactly what
 * ensureSoulFiles will write, and the tests can assert the shape.
 */
function soulTemplates({ name, role = '', personaPrompt = '', created = '' } = {}) {
  const agentName = String(name || 'Agent').trim() || 'Agent';
  const agentRole = String(role || '').trim();
  /* A role line is only meaningful when a role exists; an empty one would read
   * as "Role: " and invite the model to invent one. */
  const roleLine = agentRole ? `- Role: ${agentRole}\n` : '';
  const how = String(personaPrompt || '').trim()
    || 'A careful, competent coding agent working in the bound project. Inspect before editing, keep changes minimal, and verify with the available tools.';
  const soul = `# SOUL.md — ${agentName}\n`
    + `_This file is ${agentName}'s persona. Edit it to change who this agent is._\n`
    + '\n## Identity\n'
    + `- Name: ${agentName}\n`
    + roleLine
    + `- Created: ${created}\n`
    + '\n'
    + `## How ${agentName} works\n`
    + `${how}\n`;
  const memory = `# MEMORY.md — ${agentName}\n`
    + `_Durable notes for ${agentName}. Append what should be remembered across conversations; newest last._\n`
    + `- ${created} — Created this agent's memory.\n`;
  return { soul, memory };
}

/**
 * Create whichever of SOUL.md / MEMORY.md is missing.
 *
 * IDEMPOTENT AND NON-DESTRUCTIVE: an existing file is never rewritten, so a
 * second call reports created {soul:false, memory:false} and leaves the agent's
 * own writing byte-identical. Writes are atomic (tmp + rename, 0600).
 */
function ensureSoulFiles(agentId, userDataDir, { name, role = '', personaPrompt = '', now = null } = {}) {
  const safe = assertAgentId(agentId);
  const files = soulFiles(safe, userDataDir);
  const created = now || new Date().toISOString();
  fs.mkdirSync(files.dir, { recursive: true });
  const out = { dir: files.dir, soul: files.soul, memory: files.memory, created: { soul: false, memory: false } };
  const rendered = soulTemplates({ name: name || safe, role, personaPrompt, created });
  if (!fs.existsSync(files.soul)) {
    atomicWriteText(files.soul, rendered.soul);
    out.created.soul = true;
  }
  if (!fs.existsSync(files.memory)) {
    atomicWriteText(files.memory, rendered.memory);
    out.created.memory = true;
  }
  return out;
}

/* '' when the file is missing, so callers may concatenate unconditionally. */
function readFile(pathname, cap) {
  try {
    const text = fs.readFileSync(String(pathname), 'utf8');
    return cap ? text.slice(0, cap) : text;
  } catch {
    return '';
  }
}

function readSoul(soulPath) {
  return readFile(soulPath, MAX_SOUL_CHARS);
}

function readMemory(memoryPath) {
  return readFile(memoryPath, null);
}

/** Replace a soul file wholesale. Throws above the character cap. */
function writeSoul(soulPath, content) {
  const text = String(content ?? '');
  if (text.length > MAX_SOUL_CHARS) {
    throw new Error(`SOUL.md is at its ${MAX_SOUL_CHARS} character cap; shorten it first.`);
  }
  atomicWriteText(String(soulPath), text);
  return { path: String(soulPath), bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Append one dated entry: `- <ISO> — <entry>`.
 *
 * An oversized append is REFUSED, not silently trimmed. Memory is cumulative
 * evidence; dropping the oldest notes to make room would lose facts the agent
 * still reasons from, and it would do so invisibly. The caller is told to
 * consolidate instead. (`AgentSoulStore.append` is the rolling-window variant
 * used by the UI, which reports what it dropped; the frozen contract throws.)
 */
function appendMemory(memoryPath, entry) {
  const file = String(memoryPath);
  const body = String(entry ?? '').trim().slice(0, MAX_MEMORY_ENTRY_CHARS);
  const line = `- ${new Date().toISOString()} — ${body}\n`;
  const current = readMemory(file);
  const next = current && !current.endsWith('\n') ? `${current}\n${line}` : `${current}${line}`;
  if (Buffer.byteLength(next, 'utf8') > MAX_MEMORY_BYTES) {
    throw new Error('MEMORY.md is at its 64 KB cap; consolidate older entries first.');
  }
  atomicWriteText(file, next);
  return { path: file, bytes: Buffer.byteLength(next, 'utf8') };
}

/* The id rule the frozen spec names, kept for reference; assertAgentId applies
 * the stricter sanitizeAgentKey rule described above. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

module.exports = {
  soulDir,
  soulFiles,
  ensureSoulFiles,
  readSoul,
  readMemory,
  writeSoul,
  appendMemory,
  soulTemplates,
  AGENT_ID_PATTERN,
  MAX_SOUL_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
  MAX_MEMORY_BYTES,
};
