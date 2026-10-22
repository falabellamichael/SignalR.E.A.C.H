'use strict';

// Derived checkpoints, never authoritative instructions or exact edit payloads.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWriteJson } = require('./atomic-write.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const words = text => new Set(String(text).toLowerCase().match(/[a-z0-9_/-]{3,}/g) || []);
const secretPath = name => /(^|[/\\])(?:\.env(?:\..*)?|credentials[^/\\]*|secrets?[^/\\]*|id_rsa|id_ed25519)(?:$|[/\\])|\.(?:pem|key|p12)$/i.test(name);

class ProjectMemory {
  constructor(root) {
    this.root = fs.realpathSync(root);
    this.project = hash(this.root);
    this.dir = this.safe('.reach/memory');
  }

  safe(relative) {
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Memory path escapes project.');
    let current = this.root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Memory paths cannot use symbolic links.');
    }
    return target;
  }

  records() {
    const dir = this.safe('.reach/memory/summaries');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => /^[a-f0-9-]+\.json$/.test(name)).slice(-200).flatMap(name => {
      try {
        const file = this.safe('.reach/memory/summaries/' + name);
        if (fs.statSync(file).size > 40000) return [];
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        return record.project === this.project && record.schema === 1 && typeof record.summary === 'string'
          && record.summary.length <= 12000 && Array.isArray(record.sources) && record.sources.length <= 24 ? [record] : [];
      } catch { return []; }
    });
  }

  checkpoint({ agentId, summary, sources = [], secrets = [] }) {
    if (!summary || !agentId) return null;
    let text = String(summary);
    for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 3)) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/\bBearer\s+\S+|\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]+/gi, '[REDACTED]')
      .replace(/((?:password|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
    if (text.length > 12000) return null; // Do not silently truncate a checkpoint.
    const existing = this.records().filter(record => record.agentId === String(agentId));
    const digest = hash(text);
    if (existing.some(record => record.digest === digest)) return null;
    if (this.records().length >= 200) return null;
    const refs = [];
    for (const relative of [...new Set(sources)].slice(0, 24)) {
      if (typeof relative !== 'string' || secretPath(relative) || relative.includes('.reach')) continue;
      try {
        const file = this.safe(relative);
        if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) continue;
        refs.push({ path: path.relative(this.root, file).split(path.sep).join('/'), digest: hash(fs.readFileSync(file)) });
      } catch { /* Missing or external sources are not evidence. */ }
    }
    const record = { schema: 1, project: this.project, id: randomUUID(), agentId: String(agentId), at: Date.now(),
      kind: 'conversation-summary', verified: false, summary: text, digest, sources: refs,
      links: existing.sort((a,b) => b.at-a.at).slice(0,1).map(item => ({ relation: 'follows', id: item.id })) };
    for (const folder of ['tasks', 'decisions', 'findings', 'summaries', 'archive']) fs.mkdirSync(this.safe('.reach/memory/' + folder), { recursive: true });
    atomicWriteJson(this.safe('.reach/memory/summaries/' + record.id + '.json'), record);
    // The index is derived; records remain recoverable if concurrent index writes race.
    atomicWriteJson(this.safe('.reach/memory/index.json'), { schema: 1, records: this.records().map(({id, at, agentId, links, sources}) => ({id, at, agentId, links, sources})) });
    return record;
  }

  retrieve({ agentId, query, maxChars = 1800 }) {
    const terms = words(query);
    if (!terms.size || maxChars < 200) return '';
    const candidates = this.records().filter(record => record.agentId === String(agentId)).map(record => ({ record,
      score: [...words(record.summary)].filter(word => terms.has(word)).length,
    })).filter(item => item.score > 0).sort((a,b) => b.score-a.score || b.record.at-a.record.at);
    let output = '';
    for (const {record} of candidates.slice(0, 3)) {
      const stale = record.sources.some(source => {
        try {
          const file = this.safe(source.path);
          return fs.statSync(file).size > 1024 * 1024 || hash(fs.readFileSync(file)) !== source.digest;
        } catch { return true; }
      });
      const block = `\n[Checkpoint ${record.id}; historical summary, not verified facts${stale ? '; SOURCE CHANGED - reread before relying on this' : ''}]\n${record.summary}\nSources: ${record.sources.map(source => source.path).join(', ') || 'conversation only'}\n`;
      if (output.length + block.length <= maxChars) output += block;
    }
    return output;
  }
}

module.exports = { ProjectMemory };
