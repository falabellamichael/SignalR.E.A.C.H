'use strict';

/* Reach Studio — mid-run checkpoints (agentic capability 5, the preservation
 * half of steerable runs). Pause/stop already exists; a checkpoint is the
 * explicit "preserve this working state with a label" action, so an agent (or
 * the user, via the saved run state) can mark where a good state was before a
 * risky change.
 *
 * Checkpoints are pure records — label, description, and the files the agent
 * has touched this session — appended to a per-agent JSONL under the agent's
 * own checkpoints directory. Atomic writes, bounded sizes, fail closed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteText } = require('./atomic-write.cjs');

const LABEL = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_CHECKPOINTS = 50;
const MAX_FILES_PER_CHECKPOINT = 50;
const MAX_DESCRIPTION = 500;

function assertDir(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (!resolved) throw new Error('A checkpoint directory is required.');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function readAll(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    return raw.trimEnd().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Corrupt checkpoint file: ' + error.message);
  }
}

function appendRecord(file, record) {
  const next = [...readAll(file), record].slice(-MAX_CHECKPOINTS);
  atomicWriteText(file, next.map(item => JSON.stringify(item)).join('\n') + '\n');
  return record;
}

/** Create one labeled checkpoint. Returns the record (with seq and file). */
function createCheckpoint(dir, { agentId = 'agent', label, description = '', files = [] }) {
  const safeDir = assertDir(dir);
  const safeLabel = String(label || '').trim();
  if (!LABEL.test(safeLabel)) throw new Error('Invalid checkpoint label "' + safeLabel + '" (1-40 chars: letters, digits, . _ -).');
  const desc = String(description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
  const fileList = Array.isArray(files)
    ? [...new Set(files.map(f => String(f).trim()).filter(Boolean))].slice(0, MAX_FILES_PER_CHECKPOINT)
    : [];
  const safeAgent = String(agentId || 'agent').replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(safeDir, safeAgent + '.checkpoints.jsonl');
  const seq = readAll(file).length + 1;
  const record = appendRecord(file, {
    seq, agentId: safeAgent, label: safeLabel, description: desc,
    files: fileList, at: new Date().toISOString(),
  });
  record.file = file;
  return record;
}

/** All checkpoints for an agent, newest first. */
function listCheckpoints(dir, { agentId = 'agent' } = {}) {
  const safeDir = assertDir(dir);
  const safeAgent = String(agentId || 'agent').replace(/[^A-Za-z0-9._-]/g, '_');
  return readAll(path.join(safeDir, safeAgent + '.checkpoints.jsonl')).slice().reverse();
}

module.exports = { createCheckpoint, listCheckpoints, MAX_CHECKPOINTS, MAX_FILES_PER_CHECKPOINT };
