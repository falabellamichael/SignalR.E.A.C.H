'use strict';

/* A crew owns one append-only logical stream. Each append replaces the JSONL
 * file through atomicWriteText, so a crash leaves either the old complete
 * stream or the new one. Finished journals remain as archives. */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteText } = require('./atomic-write.cjs');

const RUN_ID = /^teamrun-[a-z0-9-]{1,80}$/;
function journalPath(dir, id) {
  if (!RUN_ID.test(String(id))) throw new Error('Invalid crew run id.');
  return path.join(dir, `${id}.team.jsonl`);
}

class CrewJournal {
  constructor(file) {
    this.file = file;
    this.records = [];
    if (fs.existsSync(file)) this.records = CrewJournal.read(file);
  }

  static read(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const records = raw.trim() ? raw.trimEnd().split('\n').map(JSON.parse) : [];
    for (let i = 0; i < records.length; i++) {
      if (records[i].seq !== i + 1 || typeof records[i].type !== 'string') throw new Error(`Invalid crew journal at record ${i + 1}.`);
    }
    return records;
  }

  append(type, detail = {}) {
    const record = { seq: this.records.length + 1, ts: new Date().toISOString(), type, ...detail };
    const next = [...this.records, record];
    atomicWriteText(this.file, next.map(item => JSON.stringify(item)).join('\n') + '\n');
    this.records = next;
    return record;
  }

  evidence(agentId = null) {
    const decisions = new Map(this.records.filter(item => item.type === 'evidence-decision').map(item => [item.editId, item]));
    return this.records.filter(item => item.type === 'evidence' && (!agentId || item.agentId === agentId))
      .map(item => {
        const decision = decisions.get(item.editId);
        return decision ? { ...item, ok: decision.accepted, pending: false, decision: decision.accepted ? 'accepted' : 'declined' } : item;
      });
  }

  snapshot() {
    const manifest = this.records.find(item => item.type === 'manifest') || null;
    const complete = this.records.findLast(item => item.type === 'complete') || null;
    return {
      runId: manifest?.runId || path.basename(this.file, '.team.jsonl'),
      manifest, complete, recoverable: !!manifest && !complete,
      members: this.records.filter(item => item.type === 'member-turn'),
      messages: this.records.filter(item => item.type === 'crew-message'),
      nurse: this.records.filter(item => item.type === 'nurse-action'),
      evidence: this.evidence(),
    };
  }
}

function listRecoverable(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.team.jsonl')).map(name => {
    try { return new CrewJournal(path.join(dir, name)).snapshot(); }
    catch (error) { return { runId: name.slice(0, -'.team.jsonl'.length), recoverable: false, error: error.message }; }
  }).filter(item => item.recoverable);
}

module.exports = { CrewJournal, journalPath, listRecoverable };
